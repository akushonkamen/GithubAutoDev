/**
 * Intake multi-round clarifier state machine — T-INTAKE-005, spec §12.0 Tier 3.
 *
 * Per-session states:
 *
 *   pending     ── user opened a session, no clarifier question sent yet
 *   confirming  ── clarifier asked N rounds (1..maxClarifyRounds)
 *   ready       ── confidence ≥ threshold → issue can be created
 *   dropped     ── user gave up OR inactivity_timeout OR max rounds exceeded
 *
 * All state lives in PostgreSQL `intake_sessions` — never in the artifact
 * store (spec §12.0). The state machine here is pure: it accepts the
 * current state and an input event and returns the next state + a
 * suggested clarifier question to ask the user.
 *
 * Inactivity sweep is a separate concern (cgao-intake-timeout-sweeper
 * cron job), but the helper `isInactive` is here so the sweeper can
 * reuse the logic.
 */

import { type ClassificationHint, classifyWithLLMResponse } from './classifier.js';

export type IntakeSessionState = 'pending' | 'confirming' | 'ready' | 'dropped';

export interface IntakeSession {
  id: string;
  state: IntakeSessionState;
  /** Number of clarifier rounds already asked. */
  round: number;
  /** Last confidence value the LLM returned (0..1). */
  lastConfidence: number;
  /** ISO-8601 timestamp of the last user message we saw. */
  lastUserAt: string;
  /** ISO-8601 timestamp the session was opened. */
  openedAt: string;
  /** Reason when state=dropped, for audit. */
  dropReason?: 'inactivity_timeout' | 'max_rounds' | 'user_abandoned' | null;
  /** Accumulated conversation summary the clarifier prompt builds on. */
  transcriptSummary: string;
}

export interface ClarifierConfig {
  maxRounds: number;
  confidenceThreshold: number;
  inactivityTimeoutMs: number;
}

export const DEFAULT_CLARIFIER_CONFIG: ClarifierConfig = {
  maxRounds: 5,
  confidenceThreshold: 0.7,
  inactivityTimeoutMs: 24 * 60 * 60 * 1000, // 24h
};

export interface ClarifierInput {
  /** The new user message that just arrived. */
  message: string;
  /** LLM confidence for this latest message (0..1). */
  confidence: number;
  /** Optional explicit-trigger fast-path flag — bypasses clarifier. */
  explicitTriggered?: boolean;
  /** True if user said "cancel"/"never mind"/"drop it". */
  userAbandoned?: boolean;
  /** Wall clock for tests; production uses now(). */
  now?: Date;
}

export interface ClarifierOutput {
  session: IntakeSession;
  /** Suggested question to ask the user next, or null when terminal. */
  nextQuestion: string | null;
  /** True when the session reached a terminal state. */
  done: boolean;
  /** When done and ready, the caller creates the issue. */
}

/**
 * Advance a session by one user message. Pure: caller persists the
 * returned session and surfaces `nextQuestion` to the IM transport.
 */
export function advance(
  prev: IntakeSession,
  input: ClarifierInput,
  config: ClarifierConfig,
): ClarifierOutput {
  const now = input.now ?? new Date();

  // Terminal states are sticky: once ready or dropped, ignore further messages.
  if (prev.state === 'ready' || prev.state === 'dropped') {
    return { session: prev, nextQuestion: null, done: true };
  }

  // User abandoned at any time → dropped.
  if (input.userAbandoned) {
    return {
      session: {
        ...prev,
        state: 'dropped',
        dropReason: 'user_abandoned',
        lastUserAt: now.toISOString(),
      },
      nextQuestion: null,
      done: true,
    };
  }

  // Explicit trigger bypasses clarifier entirely.
  if (input.explicitTriggered) {
    return {
      session: {
        ...prev,
        state: 'ready',
        lastConfidence: 1,
        lastUserAt: now.toISOString(),
        transcriptSummary: appendTurn(prev.transcriptSummary, input.message),
      },
      nextQuestion: null,
      done: true,
    };
  }

  // Confidence above threshold → ready, no more questions.
  if (input.confidence >= config.confidenceThreshold) {
    return {
      session: {
        ...prev,
        state: 'ready',
        lastConfidence: input.confidence,
        lastUserAt: now.toISOString(),
        transcriptSummary: appendTurn(prev.transcriptSummary, input.message),
      },
      nextQuestion: null,
      done: true,
    };
  }

  // Below threshold after maxRounds → dropped.
  const nextRound = prev.round + 1;
  if (nextRound > config.maxRounds) {
    return {
      session: {
        ...prev,
        state: 'dropped',
        dropReason: 'max_rounds',
        round: prev.round,
        lastConfidence: input.confidence,
        lastUserAt: now.toISOString(),
      },
      nextQuestion: null,
      done: true,
    };
  }

  // Otherwise: ask another clarifier question.
  const question = nextClarifierQuestion(prev, input, nextRound);
  return {
    session: {
      ...prev,
      state: 'confirming',
      round: nextRound,
      lastConfidence: input.confidence,
      lastUserAt: now.toISOString(),
      transcriptSummary: appendTurn(prev.transcriptSummary, input.message),
    },
    nextQuestion: question,
    done: false,
  };
}

/** Detect inactivity so the sweeper can mass-drop stale sessions. */
export function isInactive(session: IntakeSession, now: Date, config: ClarifierConfig): boolean {
  if (session.state === 'ready' || session.state === 'dropped') return false;
  const last = Date.parse(session.lastUserAt);
  if (Number.isNaN(last)) return false;
  return now.getTime() - last > config.inactivityTimeoutMs;
}

/** Build a fresh session for a brand-new intake. */
export function freshSession(args: {
  id: string;
  now?: Date;
  initialSummary?: string;
}): IntakeSession {
  const now = args.now ?? new Date();
  return {
    id: args.id,
    state: 'pending',
    round: 0,
    lastConfidence: 0,
    lastUserAt: now.toISOString(),
    openedAt: now.toISOString(),
    dropReason: null,
    transcriptSummary: args.initialSummary ?? '',
  };
}

/**
 * Drop an inactive session. Caller is the sweeper; we don't mutate in
 * place, we return a new session so the same persistence path applies.
 */
export function dropForInactivity(session: IntakeSession, now: Date): IntakeSession {
  if (session.state !== 'pending' && session.state !== 'confirming') return session;
  return {
    ...session,
    state: 'dropped',
    dropReason: 'inactivity_timeout',
    lastUserAt: now.toISOString(),
  };
}

function nextClarifierQuestion(
  prev: IntakeSession,
  input: ClarifierInput,
  nextRound: number,
): string {
  // Simple template; production wires an LLM prompt (with envelope). The
  // goal here is to verify the state machine drives question count.
  const gap = (input.confidence - 0).toFixed(2);
  void prev;
  return [
    `Clarifier round ${nextRound}:`,
    `I see confidence=${gap}. To create the issue I need a bit more.`,
    '- What component or service is affected?',
    '- What did you observe vs. what you expected?',
    '- When did it start, and is it still happening?',
  ].join('\n');
}

function appendTurn(prev: string, message: string): string {
  const turn = `USER: ${message.trim().slice(0, 200)}`;
  return prev ? `${prev}\n${turn}` : turn;
}

/** Re-export the LLM-response folder so callers have one import path. */
export { classifyWithLLMResponse };
export type { ClassificationHint };

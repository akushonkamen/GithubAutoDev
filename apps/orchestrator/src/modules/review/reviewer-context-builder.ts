/**
 * ReviewerContextBuilder + HandoffFilter — T-M8-005, spec §5 / §12.9.
 *
 * Assembles the reviewer's input bundle: RequirementSpec +
 * ImplementationPlan + diff + test evidence (gate log). The reviewer
 * does NOT receive the executor's self-defense narrative (spec §12.9).
 *
 * Defense-in-depth (spec §5):
 *
 *   - The handoff's readHandoff({ reader: 'reviewer' }) already redacts
 *     executorNarrative. The HandoffFilter runs a SECOND pass over the
 *     rendered context to strip any narrative that might have leaked
 *     through a tampered handoff. The reviewer prompt is regex-asserted
 *     in tests to contain no `executorNarrative` payload.
 *
 *   - Diff content is untrusted (it contains user code) and is wrapped
 *     via wrapUntrusted before interpolation into the prompt.
 */

import { wrapUntrusted } from '../intake/envelope.js';
import { type Handoff, type ReadHandoffResult, readHandoff } from '../specs/handoff.js';
import type { ImplementationPlan } from '../specs/implementation-plan.js';
import type { RequirementSpec } from '../specs/requirement-spec.js';

/** Minimal gate-evidence shape the reviewer cares about. */
export interface ReviewerGateEvidence {
  passed: boolean;
  logArtifactRef: string;
  /** Optional rolled-up summary (trusted, cgao-rendered). */
  summary?: string;
}

export interface ReviewerContextInput {
  spec: RequirementSpec;
  plan: ImplementationPlan;
  /** dev→review handoff produced by the dev stage. */
  handoff: Handoff;
  /** Unified diff text (untrusted — user code). */
  diff: string;
  /** Gate evidence from the fast gate run. */
  gate: ReviewerGateEvidence;
}

export interface BuiltReviewerContext {
  /** The rendered prompt body (system + trusted + wrapped untrusted). */
  prompt: string;
  /** What was redacted when reading the handoff. */
  redactions: ReadHandoffResult['redactions'];
  /** Whether the second-pass HandoffFilter stripped anything additional. */
  filterStripped: boolean;
}

/** Sentinel used to detect leaked narrative in the rendered prompt. */
export const NARRATIVE_SENTINEL = 'executorNarrative';

/**
 * Second-pass filter over the handoff payload. Even if a tampered
 * upstream pushed a handoff whose executorNarrative survived the schema
 * (it shouldn't, but defense-in-depth), this function zeros it out
 * before the reviewer sees the rendered context.
 */
export function applyHandoffFilter(handoff: Handoff): {
  handoff: Handoff;
  stripped: boolean;
} {
  if (handoff.payload.kind !== 'dev_to_review') {
    return { handoff, stripped: false };
  }
  const data = handoff.payload.data;
  if (data.executorNarrative === '' || data.executorNarrative === '[redacted]') {
    return { handoff, stripped: false };
  }
  return {
    handoff: {
      ...handoff,
      payload: {
        ...handoff.payload,
        data: { ...data, executorNarrative: '[redacted]' },
      },
    },
    stripped: true,
  };
}

/**
 * Build the reviewer's prompt. Layout:
 *
 *   1. Trusted system role + review instructions.
 *   2. RequirementSpec (trusted, cgao-authored).
 *   3. ImplementationPlan (trusted, cgao-authored).
 *   4. Gate evidence summary (trusted).
 *   5. dev→review handoff payload (filtered; risks + changedFiles + testsRun).
 *   6. UNTRUSTED diff wrapped in the envelope.
 */
export function buildReviewerContext(input: ReviewerContextInput): BuiltReviewerContext {
  const { handoff: readHandoff_, redactions } = readHandoff({
    handoff: input.handoff,
    reader: 'reviewer',
  });
  const { handoff: filtered, stripped } = applyHandoffFilter(readHandoff_);

  const parts: string[] = [];

  parts.push(REVIEW_SYSTEM_INSTRUCTION);

  parts.push(
    `--- RequirementSpec (TRUSTED, cgao-authored) ---\nrepo=${input.spec.repo}\nissue_number=${input.spec.issueNumber}\nissue_snapshot_sha=${input.spec.issueSnapshotSha}\n${JSON.stringify(input.spec)}`,
  );

  parts.push(
    `--- ImplementationPlan (TRUSTED, cgao-authored) ---\nplan_id=${input.plan.planId}\nplan_sha=${input.plan.planSha}\n${JSON.stringify(input.plan)}`,
  );

  parts.push(
    `--- GateEvidence (TRUSTED) ---\npassed=${input.gate.passed}\nlog_artifact_ref=${input.gate.logArtifactRef}${input.gate.summary ? `\nsummary=${input.gate.summary}` : ''}`,
  );

  // Handoff payload — only the structured fields a reviewer needs.
  // executorNarrative is REDACTED by readHandoff + applyHandoffFilter.
  if (filtered.payload.kind === 'dev_to_review') {
    const data = filtered.payload.data;
    parts.push(
      [
        '--- Handoff dev→review (TRUSTED scaffold; executor narrative REDACTED) ---',
        `baseSha=${data.baseSha}`,
        `headSha=${data.headSha}`,
        `patchSha=${data.patchSha}`,
        `changedFiles=${JSON.stringify(data.changedFiles)}`,
        `testsRun=${JSON.stringify(data.testsRun)}`,
        `risks=${JSON.stringify(data.risks)}`,
      ].join('\n'),
    );
  }

  // Diff is UNTRUSTED (user code). Wrap before interpolation.
  parts.push(`--- Diff (UNTRUSTED — user code) ---\n${wrapUntrusted(input.diff)}`);

  const prompt = parts.join('\n\n');

  // Defense-in-depth assertion: the rendered prompt must not contain
  // the raw executorNarrative field marker. The wrap above means any
  // forged narrative inside the diff is inside an envelope, but the
  // trusted scaffold segments must not leak the field name either.
  if (prompt.includes(`"${NARRATIVE_SENTINEL}"`)) {
    // This is a programmatic guard; tests assert it never fires given
    // well-formed input. If it fires, the handoff filter failed.
    throw new Error(
      'ReviewerContextBuilder: executorNarrative leaked into rendered reviewer prompt',
    );
  }

  return { prompt, redactions, filterStripped: stripped };
}

export const REVIEW_SYSTEM_INSTRUCTION = [
  'You are the cgao code reviewer.',
  'Your job: decide whether the patch below is safe to merge.',
  'You see the RequirementSpec, the ImplementationPlan, the gate evidence,',
  'the dev→review handoff (risks + changed files + tests run), and the diff.',
  'You do NOT see the executor self-defense narrative — form an independent opinion.',
  'Findings MUST cite rule, file, line range, message, severity, and blocking flag.',
  'Output ReviewResult JSON only.',
].join(' ');

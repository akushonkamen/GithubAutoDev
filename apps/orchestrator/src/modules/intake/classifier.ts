/**
 * Intake trigger classification — T-INTAKE-003, spec §12.0 Tier 1/2/3.
 *
 * Tier 1 — explicit trigger: @bot mention + a keyword from the
 *   configured dictionary (e.g. "bug", "deploy", "alert"). Purely
 *   deterministic; no LLM call.
 * Tier 2 — LLM soft classification: produces confidence + category
 *   hint. Wrapped through the untrusted envelope (T-INTAKE-007).
 * Tier 3 — multi-round clarifier (T-INTAKE-005).
 *
 * The classifier output is always advisory — never authoritative.
 * The authoritative label set happens later in MOD-ISSUE.
 */

import { z } from 'zod';
import { type UntrustedEnvelope, envelope, looksLikeInjection } from './envelope.js';

export const intakeModeSchema = z.enum(['auto', 'confirm', 'off']);
export type IntakeMode = z.infer<typeof intakeModeSchema>;

export interface IntakeSourceConfig {
  /** Lowercased keywords that count as explicit triggers when paired with @bot. */
  explicitKeywords: readonly string[];
}

export interface ExplicitTriggerResult {
  triggered: boolean;
  matchedKeyword: string | null;
}

/** Default keywords; override per source via .cgao.yml. */
export const DEFAULT_EXPLICIT_KEYWORDS = [
  'bug',
  'incident',
  'deploy',
  'deployment',
  'alert',
  'outage',
  'broken',
  'crash',
  'failed',
  'help',
] as const;

const MENTION_PATTERNS: ReadonlyArray<RegExp> = [/@cgao\b/iu, /@cgao[-_]bot\b/iu];

/**
 * Detect whether the message is an explicit trigger: a bot mention plus
 * a keyword from the configured dictionary. Mentions are matched
 * case-insensitively.
 *
 * Returns the matched keyword (lowercased) or null.
 */
export function isExplicitTrigger(
  message: string,
  mentions: readonly string[],
  config: IntakeSourceConfig,
): ExplicitTriggerResult {
  const mentionHit =
    mentions.some((m) => MENTION_PATTERNS.some((re) => re.test(m))) ||
    MENTION_PATTERNS.some((re) => re.test(message));
  if (!mentionHit) return { triggered: false, matchedKeyword: null };

  const lower = message.toLowerCase();
  for (const kw of config.explicitKeywords) {
    if (!kw) continue;
    const needle = kw.toLowerCase();
    // Word-boundary match so "bug" doesn't fire on "hugbug".
    const re = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'u');
    if (re.test(lower)) {
      return { triggered: true, matchedKeyword: needle };
    }
  }
  return { triggered: false, matchedKeyword: null };
}

export interface ClassificationHint {
  /** 0..1 — caller compares to confidenceThreshold to decide ready. */
  confidence: number;
  categoryHint: 'bug' | 'feature' | 'security' | 'incident' | 'question' | 'unknown';
  severityHint: 'low' | 'medium' | 'high' | 'unknown';
  /** True when scanForInjection found anything suspicious. */
  injectionSuspected: boolean;
}

export interface ClassifierLLMRequest {
  envelope: UntrustedEnvelope;
  /** Identifier for the model the caller wants (e.g. 'haiku', 'sonnet'). */
  modelHint: 'haiku' | 'sonnet';
}

export interface ClassifierLLMResponse {
  confidence: number;
  categoryHint: ClassificationHint['categoryHint'];
  severityHint: ClassificationHint['severityHint'];
}

/** Function-shape injected by the runtime to call the LLM provider. */
export type LLMClassifyFn = (req: ClassifierLLMRequest) => Promise<ClassifierLLMResponse>;

export interface ClassifierConfig {
  explicitKeywords?: readonly string[];
  confidenceThreshold: number;
  maxClarifyRounds: number;
  /** Default model tier; explicit-trigger fast path can downgrade to haiku. */
  defaultModel: 'haiku' | 'sonnet';
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  confidenceThreshold: 0.7,
  maxClarifyRounds: 5,
  defaultModel: 'sonnet',
};

export interface ClassifyArgs {
  message: string;
  mentions: readonly string[];
  mode: IntakeMode;
  config: ClassifierConfig;
  sourceConfig: IntakeSourceConfig;
  /** Injected LLM call (so this module stays pure / testable). */
  llm?: LLMClassifyFn;
}

export interface ClassifyResult {
  /** What tier produced this result. */
  tier: 'explicit' | 'llm' | 'rejected';
  ready: boolean;
  /** True when explicit-trigger fast path was taken. */
  fastPath: boolean;
  hint: ClassificationHint;
  /** The envelope the LLM should receive (or null when no LLM call). */
  llmRequest: ClassifierLLMRequest | null;
}

/**
 * Run the tiered classifier. Pure: when an LLM call is needed, this
 * returns the prepared request envelope and the caller invokes the LLM
 * separately and feeds the response back via classifyWithLLMResponse().
 *
 * The reason for splitting is so the classifier can be tested without
 * a live LLM: the test stubs out the LLM and feeds the response back
 * through classifyWithLLMResponse().
 */
export function classify(args: ClassifyArgs): ClassifyResult {
  if (args.mode === 'off') {
    return {
      tier: 'rejected',
      ready: false,
      fastPath: false,
      hint: {
        confidence: 0,
        categoryHint: 'unknown',
        severityHint: 'unknown',
        injectionSuspected: looksLikeInjection(args.message),
      },
      llmRequest: null,
    };
  }

  const env = envelope(args.message);

  // Tier 1: explicit trigger — fast path, haiku-eligible, no LLM.
  const explicit = isExplicitTrigger(args.message, args.mentions, args.sourceConfig);
  if (explicit.triggered) {
    const hint: ClassificationHint = {
      confidence: 1.0,
      categoryHint: categoryFromKeyword(explicit.matchedKeyword),
      severityHint: severityFromKeyword(explicit.matchedKeyword),
      injectionSuspected: env.injection.suspicious,
    };
    return {
      tier: 'explicit',
      ready: true,
      fastPath: true,
      hint,
      // Even explicit-trigger paths may want LLM for category refinement;
      // caller decides whether to skip. We prepare the envelope so the
      // untrusted-content invariant is auditable.
      llmRequest: { envelope: env, modelHint: 'haiku' },
    };
  }

  // Tier 2: LLM soft classification (no fast-path downgrade).
  return {
    tier: 'llm',
    ready: false,
    fastPath: false,
    hint: {
      confidence: 0,
      categoryHint: 'unknown',
      severityHint: 'unknown',
      injectionSuspected: env.injection.suspicious,
    },
    llmRequest: { envelope: env, modelHint: args.config.defaultModel },
  };
}

/** Fold an LLM response into a final ClassificationHint. */
export function classifyWithLLMResponse(
  base: ClassifyResult,
  llm: ClassifierLLMResponse,
  threshold: number,
): ClassifyResult {
  if (!base.llmRequest) return base;
  const hint: ClassificationHint = {
    confidence: clamp01(llm.confidence),
    categoryHint: llm.categoryHint,
    severityHint: llm.severityHint,
    injectionSuspected: base.hint.injectionSuspected,
  };
  return {
    ...base,
    ready: base.tier === 'explicit' ? true : hint.confidence >= threshold,
    hint,
  };
}

function categoryFromKeyword(kw: string | null): ClassificationHint['categoryHint'] {
  if (!kw) return 'unknown';
  if (
    kw === 'security' ||
    kw === 'incident' ||
    kw === 'outage' ||
    kw === 'deploy' ||
    kw === 'deployment' ||
    kw === 'alert'
  ) {
    return 'incident';
  }
  if (kw === 'bug' || kw === 'crash' || kw === 'broken' || kw === 'failed') return 'bug';
  if (kw === 'help') return 'question';
  return 'unknown';
}

function severityFromKeyword(kw: string | null): ClassificationHint['severityHint'] {
  if (kw === 'incident' || kw === 'outage' || kw === 'security' || kw === 'alert') return 'high';
  if (
    kw === 'crash' ||
    kw === 'failed' ||
    kw === 'broken' ||
    kw === 'deploy' ||
    kw === 'deployment'
  ) {
    return 'medium';
  }
  return 'low';
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function clamp01(n: number): number {
  if (Number.isNaN(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

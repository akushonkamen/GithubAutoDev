/**
 * Merge module shared types — T-M9-001..006, spec §12.10 / §14.2 / §21.
 *
 * Every authoritative merge decision is SHA-bound to the head/base SHAs
 * that produced it. The orchestrator never trusts a stale gate signal
 * bound to an old head; never re-uses a human approval recorded against
 * a different commit; and never reaches into GitHub's merge API without
 * a fresh, re-hydrated PR state.
 *
 * This file owns ONLY the type surface shared across the merge module's
 * files. Concrete services live in their respective files.
 */

/** Git commit SHA (40 hex chars, sha-1 style). Kept loose for forks. */
export type Sha = string;

/**
 * The five gate kinds the final evaluator aggregates. Each one is
 * independent: a green test gate never compensates for a red security
 * gate, and a passing human-review gate is required for high-risk PRs
 * regardless of how the other gates came out.
 */
export type GateKind =
  | 'test' // fast-gate log: lint + typecheck + unit
  | 'ai_review' // code reviewer + security reviewer
  | 'human_review' // maintainer approval recorded against head_sha
  | 'risk_policy' // deterministic risk classification (cgao_v3 §12.11)
  | 'security_findings'; // unresolved blocking findings = red

/** Per-gate evaluation outcome. */
export interface GateEvaluation {
  kind: GateKind;
  /** True iff the gate is satisfied for the current (head, base). */
  passed: boolean;
  /** Human-readable reason — used in the merge-ready comment. */
  reason: string;
  /** Artifact / row references backing the verdict (auditor follows these). */
  evidenceRefs: readonly string[];
  /** Head SHA the underlying signal was bound to; must equal currentHeadSha. */
  headSha: Sha;
  /** Base SHA the underlying signal was bound to (best-effort for human). */
  baseSha?: Sha;
}

/** Aggregated gate output for a (run, head, base). */
export interface AggregatedGates {
  runId: string;
  headSha: Sha;
  baseSha: Sha;
  /** True iff every required gate is `passed`. */
  mergeable: boolean;
  /** Per-kind evaluations. Missing kinds count as `passed=false`. */
  gates: Record<GateKind, GateEvaluation | undefined>;
  /** Gates whose headSha ≠ current were excluded; logged for audit. */
  excludedStale: readonly { kind: GateKind; reason: string }[];
}

/** Final evaluator decision. */
export type MergeDecisionKind = 'merge' | 'refuse' | 'queue';

/** Persisted MergeDecision artifact — bound to a SHA-pinned moment in time. */
export interface MergeDecision {
  runId: string;
  prNumber: number;
  /** The decision reached. */
  decision: MergeDecisionKind;
  /** Live PR head sha as re-read from GitHub at evaluation time. */
  currentHeadSha: Sha;
  /** Head sha the test/review/approval gates were bound to. */
  testedHeadSha: Sha;
  /** Base sha the gates were bound to. */
  testedBaseSha: Sha;
  /** Live PR base sha as re-read from GitHub. */
  currentBaseSha: Sha;
  /** `sha256:<hex>` over canonical(MergeDecision body). */
  digest: string;
  /** Free-text reasons, each human-readable (also surfaced in the comment). */
  reasons: string[];
  /** ISO timestamp. */
  createdAt: string;
}

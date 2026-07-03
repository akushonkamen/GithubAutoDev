/**
 * GateAggregator — T-M9-001, spec §12.10 / §15.
 *
 * Aggregates the five gate kinds into a single SHA-bound AggregatedGates
 * result. Pure orchestration: it delegates signal collection to
 * GateResultsReader (which itself talks to the per-domain lookups) and
 * then derives `mergeable` from the per-kind evaluations.
 *
 * Contract:
 *
 *   - All gates are bound to (headSha, baseSha). A signal whose headSha
 *     ≠ currentHeadSha is excluded and surfaced in `excludedStale` so
 *     the audit chain shows the staleness (spec §12.10).
 *   - `mergeable === true` IFF every required gate has `passed === true`.
 *   - High-risk PRs additionally require the human-review gate (the
 *     caller passes requiresHumanReview so the aggregator doesn't need
 *     to re-derive it from the risk record).
 */

import type { GateResultsReader } from './gate-results-reader.js';
import type {
  AggregatedGates,
  GateEvaluation,
  GateKind,
  Sha,
} from './types.js';

export interface AggregateInput {
  runId: string;
  prNumber: number;
  headSha: Sha;
  baseSha: Sha;
  /** True iff the run's risk classification requires human review. */
  requiresHumanReview?: boolean;
}

const REQUIRED_KINDS: readonly GateKind[] = [
  'test',
  'ai_review',
  'human_review',
  'risk_policy',
  'security_findings',
];

export class GateAggregator {
  constructor(private readonly reader: GateResultsReader) {}

  async aggregate(input: AggregateInput): Promise<AggregatedGates> {
    const read = await this.reader.read({
      runId: input.runId,
      prNumber: input.prNumber,
      currentHeadSha: input.headSha,
      currentBaseSha: input.baseSha,
    });

    const gates: Record<GateKind, GateEvaluation | undefined> = {
      test: read.evaluations.test,
      ai_review: read.evaluations.ai_review,
      human_review: read.evaluations.human_review,
      risk_policy: read.evaluations.risk_policy,
      security_findings: read.evaluations.security_findings,
    };

    // If a high-risk PR is missing the human-review gate, the gate is
    // treated as failed; the policy decision writer records the deny.
    const requireHuman = input.requiresHumanReview ?? false;

    let mergeable = true;
    for (const kind of REQUIRED_KINDS) {
      const g = gates[kind];
      const passed = g?.passed === true;
      if (!passed) {
        mergeable = false;
      }
      if (kind === 'human_review' && requireHuman && !passed) {
        mergeable = false;
      }
    }

    return {
      runId: input.runId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      mergeable,
      gates,
      excludedStale: read.excludedStale,
    };
  }
}

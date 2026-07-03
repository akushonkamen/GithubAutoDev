/**
 * PolicyDecisionWriter — T-M9-001, spec §12.10 / §15.
 *
 * Emits one PolicyDecision row per gate evaluation so the final
 * evaluator and the reconciler (T-M10-001) can replay the merge
 * verdict. High-risk PRs additionally require the human-review gate
 * to have passed; that constraint is enforced here as a separate
 * decision record so auditors can see both signals independently.
 *
 * Contract:
 *
 *   - One PolicyDecision row per (runId, gate, headSha).
 *   - The decision text is one of {'allow','deny','needs_review'}.
 *   - High-risk PR with missing/stale human review → deny record.
 *   - The writer never throws on missing gates; it records `deny` so
 *     the audit chain is complete even on early-stage failures.
 */

import { randomUUID } from 'node:crypto';
import type { AggregatedGates, GateEvaluation, GateKind } from './types.js';

/** Minimal port over the db-level policy_decisions table. */
export interface PolicyDecisionRecord {
  id: string;
  runId: string;
  policyVersion: string;
  decision: 'allow' | 'deny' | 'needs_review';
  reason: Record<string, unknown>;
  headSha: string;
  baseSha: string;
  createdAt: Date;
}

export interface PolicyDecisionRepository {
  insert(record: PolicyDecisionRecord): Promise<void>;
}

export interface PolicyDecisionWriteInput {
  runId: string;
  aggregated: AggregatedGates;
  /** Policy version — bump when the gate-set or risk rules change. */
  policyVersion?: string;
  /** High-risk PRs require a passing human-review gate. */
  requiresHumanReview: boolean;
  now?: Date;
  idFactory?: () => string;
}

const GATE_TO_REASON_KEY: Record<GateKind, string> = {
  test: 'test',
  ai_review: 'aiReview',
  human_review: 'humanReview',
  risk_policy: 'riskPolicy',
  security_findings: 'securityFindings',
};

export class PolicyDecisionWriter {
  constructor(private readonly repo: PolicyDecisionRepository) {}

  async write(input: PolicyDecisionWriteInput): Promise<readonly PolicyDecisionRecord[]> {
    const now = input.now ?? new Date();
    const id = input.idFactory ?? randomUUID;
    const policyVersion = input.policyVersion ?? 'cgao/merge/v1';
    const out: PolicyDecisionRecord[] = [];

    for (const kind of Object.keys(input.aggregated.gates) as GateKind[]) {
      const gate: GateEvaluation | undefined = input.aggregated.gates[kind];
      const decision: PolicyDecisionRecord['decision'] = gate?.passed ? 'allow' : 'deny';
      const record: PolicyDecisionRecord = {
        id: `pdec_${id()}`,
        runId: input.runId,
        policyVersion,
        decision,
        reason: {
          gate: kind,
          passed: gate?.passed ?? false,
          reason: gate?.reason ?? 'gate missing',
          evidenceRefs: gate?.evidenceRefs ?? [],
          staleSignalsExcluded:
            input.aggregated.excludedStale
              .filter((e) => e.kind === kind)
              .map((e) => e.reason) ?? [],
        },
        headSha: input.aggregated.headSha,
        baseSha: input.aggregated.baseSha,
        createdAt: now,
      };
      await this.repo.insert(record);
      out.push(record);
    }

    // High-risk gate: if a human review is required AND the human-review
    // gate did not pass, emit a dedicated deny record. This is a separate
    // record from the human_review gate above so auditors can see both
    // "the gate is missing" and "the policy therefore denied".
    if (input.requiresHumanReview) {
      const humanGate = input.aggregated.gates.human_review;
      const humanPassed = humanGate?.passed === true;
      if (!humanPassed) {
        const record: PolicyDecisionRecord = {
          id: `pdec_${id()}`,
          runId: input.runId,
          policyVersion,
          decision: 'deny',
          reason: {
            gate: 'high_risk_human_review_required',
            passed: false,
            reason: 'high-risk PR requires explicit human approval at current head',
            humanReviewPassed: false,
          },
          headSha: input.aggregated.headSha,
          baseSha: input.aggregated.baseSha,
          createdAt: now,
        };
        await this.repo.insert(record);
        out.push(record);
      }
    }

    return out;
  }
}

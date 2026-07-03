/**
 * LabelReconciler — T-M10-002, spec §14.2.
 *
 * Restores the canonical label projection when a human (or a stale bot)
 * has mutated labels on an issue. Examples:
 *
 *   - `cgao:plan-ready` removed by mistake → re-applied because plan exists.
 *   - `cgao:executing` removed while still EXECUTING → re-applied.
 *   - Spurious `cgao:merged` label added before merge actually happens → removed.
 *
 * Every restoration extends the audit chain (label.set / label.unset) so
 * the operator has a tamper-evident record of the repair itself.
 */

import type { AuditChainService } from '@cgao/audit';

/** Trusted label mutation port. */
export interface LabelMutationPort {
  addLabel(args: { repo: string; issueNumber: number; label: string }): Promise<void>;
  removeLabel(args: { repo: string; issueNumber: number; label: string }): Promise<void>;
}

export interface LabelReconcileInput {
  runId: string;
  repo: string;
  issueNumber: number;
  /** Canonical labels that should be present per the DB projection. */
  expectedLabels: readonly string[];
  /** Live labels observed on the issue. */
  liveLabels: readonly string[];
}

export interface LabelReconcileResult {
  added: string[];
  removed: string[];
  reason: string;
}

export class LabelReconciler {
  constructor(
    private readonly labels: LabelMutationPort,
    private readonly audit: AuditChainService,
  ) {}

  async reconcile(input: LabelReconcileInput): Promise<LabelReconcileResult> {
    const expected = new Set(input.expectedLabels);
    const live = new Set(input.liveLabels);
    const toAdd = [...expected].filter((l) => !live.has(l));
    const toRemove = [...live].filter((l) => l.startsWith('cgao:') && !expected.has(l));

    for (const label of toAdd) {
      await this.labels.addLabel({
        repo: input.repo,
        issueNumber: input.issueNumber,
        label,
      });
      await this.audit.append({
        runId: input.runId,
        kind: 'label.set',
        payload: {
          repo: input.repo,
          issueNumber: input.issueNumber,
          label,
          source: 'reconcile.repair',
        },
      });
    }
    for (const label of toRemove) {
      await this.labels.removeLabel({
        repo: input.repo,
        issueNumber: input.issueNumber,
        label,
      });
      await this.audit.append({
        runId: input.runId,
        kind: 'label.unset',
        payload: {
          repo: input.repo,
          issueNumber: input.issueNumber,
          label,
          source: 'reconcile.repair',
        },
      });
    }

    return {
      added: toAdd,
      removed: toRemove,
      reason: toAdd.length === 0 && toRemove.length === 0 ? 'in-sync' : 'repaired',
    };
  }
}

/**
 * Label projection — T-M3-003, spec §14.1.
 *
 * cgao owns the `cgao:kind/*` and `cgao:status/*` label surface.
 * Internal state changes are projected onto that surface here. When a
 * human edits a cgao:* label directly, we DO NOT mutate internal state
 * — instead we emit a ReconciliationSignal so the reconciler can
 * decide whether to obey the human or re-project the authoritative
 * state.
 *
 * Contracts (spec §14.1):
 *
 *   - Internal status change → LabelProjectionService.apply() returns
 *     the minimal add/remove label set.
 *   - External edit to cgao:* labels → detectExternalEdit() returns a
 *     ReconciliationSignal; internal state is NEVER directly mutated.
 *   - Non-cgao labels (e.g. priority:high) are always left alone.
 */

import type { IssueCategory, IssueStatus } from './triage.js';
import { StatusProjectionService } from './triage.js';

export type { IssueCategory, IssueStatus };

export const CGAO_KIND_PREFIX = 'cgao:kind/';
export const CGAO_STATUS_PREFIX = 'cgao:status/';

/**
 * Result of projecting internal state onto the label surface.
 */
export interface LabelProjection {
  /** Lowercased labels to add. */
  add: readonly string[];
  /** Lowercased labels to remove. */
  remove: readonly string[];
}

/**
 * A signal emitted when an external actor mutates cgao:* labels.
 * The reconciler consumes this — it never directly mutates state.
 */
export interface ReconciliationSignal {
  /** The label that was added/removed by a non-cgao actor. */
  label: string;
  /** Which surface the label belongs to. */
  surface: 'kind' | 'status';
  /** Whether the external actor added or removed the label. */
  action: 'added' | 'removed';
  /** The raw value the external actor tried to set (e.g. 'bug'). */
  attemptedValue: string;
  /** The authoritative internal status/category at signal time. */
  authoritative: { category: IssueCategory; status: IssueStatus };
  /** Comment / event that introduced the change, for audit. */
  sourceCommentId?: number;
  /** Actor login (display only — never authoritative for permission). */
  actorLogin?: string;
}

export class LabelProjectionService {
  private readonly projection: StatusProjectionService;

  constructor(projection?: StatusProjectionService) {
    this.projection = projection ?? new StatusProjectionService();
  }

  /**
   * Project authoritative internal state onto the label surface.
   * Returns minimal add/remove sets vs the existing labels.
   */
  apply(
    existingLabels: readonly string[],
    desired: { category: IssueCategory; status: IssueStatus },
  ): LabelProjection {
    const diff = this.projection.diffLabels(existingLabels, desired);
    return { add: diff.add, remove: diff.remove };
  }

  /**
   * Compare two label snapshots (before/after an external event) and
   * return any cgao:* label mutations. The orchestrator treats these
   * as reconciliation signals — internal state is never directly
   * mutated by them.
   */
  detectExternalEdit(args: {
    before: readonly string[];
    after: readonly string[];
    authoritative: { category: IssueCategory; status: IssueStatus };
    sourceCommentId?: number;
    actorLogin?: string;
  }): readonly ReconciliationSignal[] {
    const beforeLower = new Set(args.before.map((l) => l.toLowerCase()));
    const afterLower = new Set(args.after.map((l) => l.toLowerCase()));
    const signals: ReconciliationSignal[] = [];

    for (const label of afterLower) {
      if (beforeLower.has(label)) continue;
      const s = labelSurface(label);
      if (!s) continue;
      signals.push({
        label,
        surface: s.surface,
        action: 'added',
        attemptedValue: label.slice(s.prefix.length),
        authoritative: args.authoritative,
        sourceCommentId: args.sourceCommentId,
        actorLogin: args.actorLogin,
      });
    }

    for (const label of beforeLower) {
      if (afterLower.has(label)) continue;
      const s = labelSurface(label);
      if (!s) continue;
      signals.push({
        label,
        surface: s.surface,
        action: 'removed',
        attemptedValue: label.slice(s.prefix.length),
        authoritative: args.authoritative,
        sourceCommentId: args.sourceCommentId,
        actorLogin: args.actorLogin,
      });
    }

    return signals;
  }

  /**
   * Format the authoritative label pair for a given state.
   */
  formatLabels(state: { category: IssueCategory; status: IssueStatus }): {
    kind: string;
    status: string;
  } {
    return {
      kind: this.projection.kindLabel(state.category),
      status: this.projection.statusLabel(state.status),
    };
  }
}

function labelSurface(label: string): { surface: 'kind' | 'status'; prefix: string } | null {
  if (label.startsWith(CGAO_KIND_PREFIX)) {
    return { surface: 'kind', prefix: CGAO_KIND_PREFIX };
  }
  if (label.startsWith(CGAO_STATUS_PREFIX)) {
    return { surface: 'status', prefix: CGAO_STATUS_PREFIX };
  }
  return null;
}

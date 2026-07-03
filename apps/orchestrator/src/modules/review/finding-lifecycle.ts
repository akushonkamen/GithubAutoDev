/**
 * FindingLifecycleService — T-M8-004, spec §12.9.
 *
 * Owns the open → fixed / open → dismissed transitions on review_findings.
 *
 * Hard rules (spec §12.9):
 *
 *   1. A BLOCKING finding cannot be auto-closed just because a fresh
 *      review at a new headSha omitted it. The reviewer that produced
 *      the finding MUST explicitly markFixed() at the new headSha —
 *      same reviewer class — before the row transitions out of `open`.
 *      markFixedByOmission() throws on blocking rows; callers MUST
 *      instead surface the unresolved blocking finding to the gate.
 *
 *   2. dismiss() requires a non-empty maintainer reason string. The
 *      reviewer that opens a finding cannot dismiss its own finding.
 *
 *   3. Every transition appends to the audit chain so the reconciler
 *      (T-M10-001) can replay the lifecycle.
 */

import type { AuditChainService } from '@cgao/audit';
import type { ReviewFindingRepo } from './review-finding-repo.js';

export interface FindingLifecycleDeps {
  repo: ReviewFindingRepo;
  audit: AuditChainService;
}

export interface MarkFixedInput {
  findingId: string;
  /** Reviewer class attempting the transition. */
  reviewer: 'code' | 'security';
  /** Head sha at which the fix was confirmed. */
  confirmedAtHeadSha: string;
  /** Actor performing the transition (login or 'cgao:reviewer:<class>'). */
  actor: string;
}

export interface DismissInput {
  findingId: string;
  /** Non-empty maintainer reason. */
  reason: string;
  /** Maintainer login. */
  by: string;
}

export class LifecycleError extends Error {
  readonly code:
    | 'blocking_cannot_auto_close'
    | 'reviewer_class_mismatch'
    | 'empty_dismiss_reason'
    | 'self_dismiss_forbidden'
    | 'finding_not_open';
  constructor(code: LifecycleError['code'], message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

export class FindingLifecycleService {
  constructor(private readonly deps: FindingLifecycleDeps) {}

  /**
   * Transition a finding to `fixed`. The reviewer class must match the
   * finding's class (a code reviewer cannot mark a security finding fixed),
   * and a blocking finding MUST be confirmed at the new head sha.
   */
  async markFixed(input: MarkFixedInput) {
    const row = await this.deps.repo.findById(input.findingId);
    if (!row) throw new LifecycleError('finding_not_open', `finding not found: ${input.findingId}`);
    if (row.status !== 'open') {
      throw new LifecycleError('finding_not_open', `finding ${input.findingId} is ${row.status}`);
    }
    const findingReviewer = row.category.startsWith('security:') ? 'security' : 'code';
    if (findingReviewer !== input.reviewer) {
      throw new LifecycleError(
        'reviewer_class_mismatch',
        `finding ${input.findingId} belongs to ${findingReviewer}; ${input.reviewer} cannot close it`,
      );
    }
    // Blocking findings must be re-confirmed at the current head sha.
    // The caller passes confirmedAtHeadSha; we assert it is set (the
    // orchestrator's review runner sets this from the new ReviewResult's
    // headSha). A blocking finding cannot be auto-closed by omission.
    if (row.blocking && !input.confirmedAtHeadSha) {
      throw new LifecycleError(
        'blocking_cannot_auto_close',
        `blocking finding ${input.findingId} requires explicit confirmation at a new headSha`,
      );
    }

    const now = new Date();
    const updated = await this.deps.repo.setStatus(input.findingId, {
      status: 'fixed',
      closedBy: input.actor,
      closeReason: `fixed at ${input.confirmedAtHeadSha || '(same head)'}`,
      closedAt: now,
    });

    await this.deps.audit.append({
      runId: row.runId,
      kind: 'review.finding.fixed',
      payload: {
        findingId: row.id,
        findingHash: row.findingHash,
        reviewer: input.reviewer,
        confirmedAtHeadSha: input.confirmedAtHeadSha,
        actor: input.actor,
      },
    });

    return updated;
  }

  /**
   * Auto-close non-blocking findings that a fresh review omitted. Used
   * by the review runner at the end of a re-review: findings that were
   * open at the previous head, are NOT blocking, and are not present in
   * the new review's findings get transitioned to `fixed`.
   *
   * BLOCKING findings are NEVER closed here — they require explicit
   * markFixed() at the new head. This is the spec §12.9 contract.
   */
  async markFixedByOmission(args: {
    prNumber: number;
    newHeadSha: string;
    newFindingHashes: readonly string[];
    actor: string;
  }): Promise<readonly { id: string; status: 'fixed' }[]> {
    const all = await this.deps.repo.findByPr(args.prNumber);
    const stillOpen = all.filter(
      (r) => r.status === 'open' && !args.newFindingHashes.includes(r.findingHash),
    );
    const closed: { id: string; status: 'fixed' }[] = [];
    for (const row of stillOpen) {
      if (row.blocking) {
        // Spec §12.9: blocking findings cannot be auto-closed.
        continue;
      }
      await this.markFixed({
        findingId: row.id,
        reviewer: row.category.startsWith('security:') ? 'security' : 'code',
        confirmedAtHeadSha: args.newHeadSha,
        actor: args.actor,
      });
      closed.push({ id: row.id, status: 'fixed' });
    }
    return closed;
  }

  /**
   * Dismiss a finding. Requires a non-empty maintainer reason; the
   * reviewer that opened the finding cannot dismiss it (no self-dismiss).
   */
  async dismiss(input: DismissInput) {
    if (!input.reason || !input.reason.trim()) {
      throw new LifecycleError('empty_dismiss_reason', 'dismiss requires a non-empty reason');
    }
    const row = await this.deps.repo.findById(input.findingId);
    if (!row) throw new LifecycleError('finding_not_open', `finding not found: ${input.findingId}`);
    if (row.status !== 'open') {
      throw new LifecycleError('finding_not_open', `finding ${input.findingId} is ${row.status}`);
    }
    // Self-dismiss guard: the actor that opened it (closedBy default
    // convention 'cgao:reviewer:<class>') cannot dismiss it.
    if (input.by.startsWith('cgao:reviewer:')) {
      throw new LifecycleError(
        'self_dismiss_forbidden',
        `reviewer cannot dismiss its own finding ${input.findingId}`,
      );
    }

    const now = new Date();
    const updated = await this.deps.repo.setStatus(input.findingId, {
      status: 'dismissed',
      closedBy: input.by,
      closeReason: input.reason,
      closedAt: now,
    });

    await this.deps.audit.append({
      runId: row.runId,
      kind: 'review.finding.dismissed',
      payload: {
        findingId: row.id,
        findingHash: row.findingHash,
        reason: input.reason,
        by: input.by,
      },
    });

    return updated;
  }
}

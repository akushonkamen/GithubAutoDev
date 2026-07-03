/**
 * ProjectionReconciler — T-M10-002, spec §12.2 / §14.1 / §14.2.
 *
 * Top-level coordinator that walks every active issue and runs:
 *   1. StatusCommentReconciler — recreate missing status comment.
 *   2. LabelReconciler — restore canonical label projection.
 *
 * Idempotent — running twice in a row with no drift produces no
 * mutations and no audit records. Safe to schedule periodically.
 */

import type { AuditChainService } from '@cgao/audit';
import { type LabelMutationPort, LabelReconciler } from './label-reconciler.js';
import { type IssueCommentPort, StatusCommentReconciler } from './status-comment-reconciler.js';

export interface ActiveIssue {
  runId: string;
  repo: string;
  issueNumber: number;
  expectedLabels: readonly string[];
  /** Live labels currently on the issue. */
  liveLabels: readonly string[];
  /** True iff the DB expects a status comment to be present. */
  expectsStatusComment: boolean;
  /** Body to use when recreating the status comment. */
  statusCommentBody: string;
}

export interface ActiveIssueReader {
  list(): Promise<readonly ActiveIssue[]>;
}

export interface ProjectionReconcilerDeps {
  issues: ActiveIssueReader;
  statusComment: StatusCommentReconciler;
  label: LabelReconciler;
  comments: IssueCommentPort;
  labelPort: LabelMutationPort;
  audit: AuditChainService;
}

export interface ProjectionReconcileSummary {
  scanned: number;
  commentsRecreated: number;
  labelsRepaired: number;
}

/**
 * Factory wires the sub-reconcilers; provided separately so tests can
 * inject stubs without rebuilding the coordinator.
 */
export function makeProjectionReconciler(deps: {
  issues: ActiveIssueReader;
  comments: IssueCommentPort;
  labelPort: LabelMutationPort;
  audit: AuditChainService;
  markerSecret: string;
}): {
  statusComment: StatusCommentReconciler;
  label: LabelReconciler;
  coordinator: ProjectionReconcilerCoordinator;
} {
  const statusComment = new StatusCommentReconciler(deps.comments, deps.audit, deps.markerSecret);
  const label = new LabelReconciler(deps.labelPort, deps.audit);
  const coordinator = new ProjectionReconcilerCoordinator({
    issues: deps.issues,
    statusComment,
    label,
    comments: deps.comments,
    labelPort: deps.labelPort,
    audit: deps.audit,
  });
  return { statusComment, label, coordinator };
}

export class ProjectionReconcilerCoordinator {
  constructor(private readonly deps: ProjectionReconcilerDeps) {}

  async tick(): Promise<ProjectionReconcileSummary> {
    const issues = await this.deps.issues.list();
    let commentsRecreated = 0;
    let labelsRepaired = 0;
    for (const issue of issues) {
      if (issue.expectsStatusComment) {
        const out = await this.deps.statusComment.reconcile({
          runId: issue.runId,
          repo: issue.repo,
          issueNumber: issue.issueNumber,
          body: issue.statusCommentBody,
        });
        if (out.recreated) commentsRecreated++;
      }
      const labels = await this.deps.label.reconcile({
        runId: issue.runId,
        repo: issue.repo,
        issueNumber: issue.issueNumber,
        expectedLabels: issue.expectedLabels,
        liveLabels: issue.liveLabels,
      });
      if (labels.reason === 'repaired') labelsRepaired++;
    }
    return { scanned: issues.length, commentsRecreated, labelsRepaired };
  }
}

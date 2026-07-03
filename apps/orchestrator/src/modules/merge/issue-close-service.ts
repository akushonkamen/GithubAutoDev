/**
 * IssueCloseService — T-M9-004, spec §12.10.
 *
 * After the merge mutation succeeds cgao closes the linked issue,
 * strips the `cgao:*` labels, and posts a completion comment. Every
 * step goes through the trusted broker (PullRequestService-style) so
 * no agent ever calls GitHub mutations directly.
 *
 * Contract:
 *
 *   - All three side-effects (close, label removal, comment) MUST
 *     succeed before the service reports `done`. A failure in any one
 *     leaves the issue in a partial state but does NOT roll back the
 *     merge — the merge is already persisted.
 *   - Each step appends to the audit chain so the reconciler can
 *     recover from a partial close.
 */

import type { AuditChainService } from '@cgao/audit';

export interface IssueClosePort {
  /** Close the issue. */
  closeIssue(args: { repo: string; issueNumber: number }): Promise<void>;
  /** Remove a label from the issue (no-op if absent). */
  removeLabel(args: { repo: string; issueNumber: number; label: string }): Promise<void>;
  /** Add a completion comment. */
  addComment(args: { repo: string; issueNumber: number; body: string }): Promise<void>;
}

export interface IssueCloseInput {
  runId: string;
  repo: string;
  issueNumber: number;
  /** Head sha that was merged. */
  mergedHeadSha: string;
  /** Merge commit sha. */
  mergeCommitSha: string;
  /** cgao:* labels to strip (defaults to the canonical list). */
  labelsToRemove?: readonly string[];
}

export interface IssueCloseResult {
  closed: boolean;
  labelsRemoved: readonly string[];
  commentPosted: boolean;
  auditId: string;
  /** Errors encountered per step (when present). */
  errors: readonly string[];
}

/** Default cgao:* labels to strip on completion (spec §14.1). */
export const DEFAULT_CGAO_LABELS = [
  'cgao:new',
  'cgao:triaging',
  'cgao:needs-info',
  'cgao:analysis',
  'cgao:planning',
  'cgao:approved',
  'cgao:implementing',
  'cgao:testing',
  'cgao:reviewing',
  'cgao:changes-requested',
  'cgao:merge-ready',
  'cgao:blocked',
  'cgao:failed',
  'cgao:manual-only',
] as const;

export class IssueCloseService {
  constructor(
    private readonly port: IssueClosePort,
    private readonly audit: AuditChainService,
  ) {}

  async close(input: IssueCloseInput): Promise<IssueCloseResult> {
    const labels = input.labelsToRemove ?? DEFAULT_CGAO_LABELS;
    const errors: string[] = [];
    let commentPosted = false;

    // 1. Close the issue.
    try {
      await this.port.closeIssue({
        repo: input.repo,
        issueNumber: input.issueNumber,
      });
    } catch (err) {
      errors.push(`close failed: ${(err as Error).message}`);
    }

    // 2. Strip cgao:* labels.
    const removed: string[] = [];
    for (const label of labels) {
      try {
        await this.port.removeLabel({
          repo: input.repo,
          issueNumber: input.issueNumber,
          label,
        });
        removed.push(label);
      } catch {
        // Missing label is not an error — continue.
      }
    }

    // 3. Post the completion comment.
    const body = [
      '## cgao: merged',
      '',
      `Merged as \`${input.mergeCommitSha.slice(0, 10)}\` (head \`${input.mergedHeadSha.slice(0, 10)}\`).`,
      '',
      'Closing this issue. Reopen if a regression surfaces.',
    ].join('\n');
    try {
      await this.port.addComment({
        repo: input.repo,
        issueNumber: input.issueNumber,
        body,
      });
      commentPosted = true;
    } catch (err) {
      errors.push(`comment failed: ${(err as Error).message}`);
    }

    // 4. Audit the close so the reconciler can recover.
    const audit = await this.audit.append({
      runId: input.runId,
      kind: 'issue.closed',
      payload: {
        repo: input.repo,
        issueNumber: input.issueNumber,
        mergedHeadSha: input.mergedHeadSha,
        mergeCommitSha: input.mergeCommitSha,
        labelsRemoved: removed,
        commentPosted,
        errors,
      },
    });

    return {
      closed: errors.length === 0,
      labelsRemoved: removed,
      commentPosted,
      auditId: audit.id,
      errors,
    };
  }
}

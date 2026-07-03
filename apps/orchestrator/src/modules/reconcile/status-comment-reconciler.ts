/**
 * StatusCommentReconciler — T-M10-002, spec §5 / §14.1.
 *
 * Spec §5 — comment markers are display-only and never authoritative;
 * however, when the cgao status comment is *missing* the operator loses
 * visibility into the workflow state. This reconciler detects a missing
 * status comment (by HMAC marker in the issue body) and recreates it
 * from the current state via a trusted broker.
 *
 * Hard rule: this module NEVER parses the existing comment to derive
 * state. State comes from the DB projection; the comment is rebuilt
 * from that source of truth.
 */

import { createHmac } from 'node:crypto';
import type { AuditChainService } from '@cgao/audit';

/** Marker HMAC'd into the comment body so we can identify cgao's own comment. */
export const STATUS_COMMENT_MARKER = '<!-- cgao:status-comment -->';

export function statusCommentMarker(runId: string, secret: string): string {
  const tag = createHmac('sha256', secret).update(`status:${runId}`).digest('hex').slice(0, 16);
  return `<!-- cgao:status-comment:${tag} -->`;
}

/** Trusted broker port for posting/removing issue comments. */
export interface IssueCommentPort {
  listComments(args: { repo: string; issueNumber: number }): Promise<
    ReadonlyArray<{ id: number; body: string }>
  >;
  addComment(args: { repo: string; issueNumber: number; body: string }): Promise<{ id: number }>;
}

export interface StatusCommentInput {
  runId: string;
  repo: string;
  issueNumber: number;
  /** Body to (re)create from. Callers compute this from the current projection. */
  body: string;
}

export interface StatusCommentResult {
  recreated: boolean;
  commentId?: number;
  reason: string;
}

export class StatusCommentReconciler {
  constructor(
    private readonly comments: IssueCommentPort,
    private readonly audit: AuditChainService,
    private readonly markerSecret: string,
  ) {}

  async reconcile(input: StatusCommentInput): Promise<StatusCommentResult> {
    const marker = statusCommentMarker(input.runId, this.markerSecret);
    const existing = await this.comments.listComments({
      repo: input.repo,
      issueNumber: input.issueNumber,
    });
    const present = existing.some(
      (c) => c.body.includes(STATUS_COMMENT_MARKER) || c.body.includes(marker),
    );
    if (present) {
      return { recreated: false, reason: 'present' };
    }
    const body = `${input.body}\n\n${marker}`;
    const out = await this.comments.addComment({
      repo: input.repo,
      issueNumber: input.issueNumber,
      body,
    });
    await this.audit.append({
      runId: input.runId,
      kind: 'status_comment.recreated',
      payload: { repo: input.repo, issueNumber: input.issueNumber, commentId: out.id },
    });
    return { recreated: true, commentId: out.id, reason: 'recreated' };
  }
}

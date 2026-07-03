/**
 * StatusCommentUpdater — T-M9-003, spec §14.2 / §12.10.
 *
 * cgao maintains ONE active status comment per PR (mirrors the issue
 * status-comment pattern from T-M3-002). The merge-ready summary is
 * posted through the trusted PullRequestService broker (from M7) —
 * never via direct GitHub mutations. When a cgao-authored status
 * comment already exists, the updater EDITS it in place; otherwise it
 * creates one.
 *
 * Contracts (spec §5, §14.2, §12.10):
 *
 *   - The comment is only posted when the final evaluator returns
 *     decision='merge'. The caller enforces this; we re-check here.
 *   - Forged markers in pre-existing comments are detected by HMAC
 *     verification — they cannot cause a status mutation.
 *   - The marker is display-only; policy decisions never read it.
 */

import { renderMergeReadyBody } from './merge-ready-renderer.js';
import type { AggregatedGates, MergeDecision } from './types.js';

/** Trusted broker port — wires to PullRequestService (M7) in production. */
export interface StatusCommentBroker {
  /** List issue comments on the PR. */
  listComments(args: {
    repo: string;
    prNumber: number;
  }): Promise<readonly PrComment[]>;
  /** Create a new comment, returning the new comment id. */
  createComment(args: {
    repo: string;
    prNumber: number;
    body: string;
  }): Promise<{ commentId: number }>;
  /** Edit the body of an existing comment. */
  editComment(args: { repo: string; prNumber: number; commentId: number; body: string }): Promise<void>;
}

export interface PrComment {
  id: number;
  body: string;
  /** Author login (used to scope marker detection to cgao bot comments). */
  authorLogin: string;
}

export interface StatusCommentUpdaterDeps {
  broker: StatusCommentBroker;
  /** HMAC secret for the marker (CGAO_CONTROL_TOKEN). */
  markerSecret: string;
  /** cgao GitHub App bot login — only comments by this author are editable. */
  cgaoBotLogin: string;
}

export interface UpdateInput {
  repo: string;
  prNumber: number;
  decision: MergeDecision;
  aggregated: AggregatedGates;
}

export interface UpdateResult {
  kind: 'created' | 'updated';
  commentId: number;
  body: string;
}

const MERGE_READY_MARKER_RE = /<!--\s*cgao:merge-ready\s+run=([^\s]+)\s*-->/u;

export class StatusCommentUpdater {
  constructor(private readonly deps: StatusCommentUpdaterDeps) {}

  async update(input: UpdateInput): Promise<UpdateResult | null> {
    // Hard rule: only post when decision='merge'. Anything else is a no-op.
    if (input.decision.decision !== 'merge') {
      return null;
    }
    const body = renderMergeReadyBody({
      aggregated: input.aggregated,
      prNumber: input.prNumber,
    });

    const comments = await this.deps.broker.listComments({
      repo: input.repo,
      prNumber: input.prNumber,
    });
    const ours = comments.find(
      (c) =>
        c.authorLogin === this.deps.cgaoBotLogin &&
        MERGE_READY_MARKER_RE.test(c.body) &&
        // run_id in the marker must match the current run.
        c.body.includes(`run=${input.decision.runId}`),
    );

    if (ours) {
      await this.deps.broker.editComment({
        repo: input.repo,
        prNumber: input.prNumber,
        commentId: ours.id,
        body,
      });
      return { kind: 'updated', commentId: ours.id, body };
    }

    const created = await this.deps.broker.createComment({
      repo: input.repo,
      prNumber: input.prNumber,
      body,
    });
    return { kind: 'created', commentId: created.commentId, body };
  }
}

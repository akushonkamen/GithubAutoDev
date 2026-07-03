/**
 * T-M10-002 StatusCommentReconciler.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { describe, expect, it } from 'vitest';
import {
  type IssueCommentPort,
  StatusCommentReconciler,
  statusCommentMarker,
} from '../status-comment-reconciler.js';

class StubComments implements IssueCommentPort {
  listed: ReadonlyArray<{ id: number; body: string }> = [];
  nextId = 100;
  added: { id: number; body: string }[] = [];
  async listComments() {
    return this.listed;
  }
  async addComment(args: { body: string }) {
    const id = this.nextId++;
    this.added.push({ id, body: args.body });
    return { id };
  }
}

describe('T-M10-002 StatusCommentReconciler', () => {
  it('creates a comment with the HMAC marker when none is present', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const r = new StatusCommentReconciler(comments, audit, 'dev-secret');
    const out = await r.reconcile({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 1,
      body: 'status: PLAN_READY',
    });
    expect(out.recreated).toBe(true);
    expect(out.commentId).toBe(100);
    const marker = statusCommentMarker('run_1', 'dev-secret');
    expect(comments.added[0]?.body).toContain(marker);
  });

  it('is a no-op when a status comment is already present', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const marker = statusCommentMarker('run_2', 'dev-secret');
    comments.listed = [{ id: 5, body: `old\n\n${marker}` }];
    const r = new StatusCommentReconciler(comments, audit, 'dev-secret');
    const out = await r.reconcile({
      runId: 'run_2',
      repo: 'cgao/test',
      issueNumber: 2,
      body: 'status',
    });
    expect(out.recreated).toBe(false);
    expect(out.reason).toBe('present');
    expect(comments.added.length).toBe(0);
  });

  it('appends an audit record on recreation', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const r = new StatusCommentReconciler(comments, audit, 'dev-secret');
    await r.reconcile({
      runId: 'run_3',
      repo: 'cgao/test',
      issueNumber: 3,
      body: 'status',
    });
    const chain = await audit.listByRun('run_3');
    expect(chain.some((rec) => rec.kind === 'status_comment.recreated')).toBe(true);
  });
});

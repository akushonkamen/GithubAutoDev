/**
 * T-M10-002 ProjectionReconcilerCoordinator.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { describe, expect, it } from 'vitest';
import type { LabelMutationPort } from '../label-reconciler.js';
import {
  type ActiveIssue,
  type ActiveIssueReader,
  makeProjectionReconciler,
} from '../projection-reconciler.js';
import type { IssueCommentPort } from '../status-comment-reconciler.js';

class StubComments implements IssueCommentPort {
  listed: ReadonlyArray<{ id: number; body: string }> = [];
  added: string[] = [];
  async listComments() {
    return this.listed;
  }
  async addComment(args: { body: string }) {
    this.added.push(args.body);
    return { id: this.added.length };
  }
}

class StubLabels implements LabelMutationPort {
  added: string[] = [];
  removed: string[] = [];
  async addLabel(args: { label: string }) {
    this.added.push(args.label);
  }
  async removeLabel(args: { label: string }) {
    this.removed.push(args.label);
  }
}

class StubReader implements ActiveIssueReader {
  constructor(private readonly issues: ActiveIssue[]) {}
  async list() {
    return this.issues;
  }
}

describe('T-M10-002 ProjectionReconciler', () => {
  it('recreates a missing status comment', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const labels = new StubLabels();
    const issues = new StubReader([
      {
        runId: 'run_1',
        repo: 'cgao/test',
        issueNumber: 7,
        expectedLabels: ['cgao:plan-ready'],
        liveLabels: ['cgao:plan-ready'],
        expectsStatusComment: true,
        statusCommentBody: 'status: PLAN_READY',
      },
    ]);
    const { coordinator } = makeProjectionReconciler({
      issues,
      comments,
      labelPort: labels,
      audit,
      markerSecret: 'dev-secret',
    });
    const out = await coordinator.tick();
    expect(out.scanned).toBe(1);
    expect(out.commentsRecreated).toBe(1);
    expect(comments.added.length).toBe(1);
    const chain = await audit.listByRun('run_1');
    expect(chain.some((r) => r.kind === 'status_comment.recreated')).toBe(true);
  });

  it('restores a human-removed label', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const labels = new StubLabels();
    const issues = new StubReader([
      {
        runId: 'run_2',
        repo: 'cgao/test',
        issueNumber: 8,
        expectedLabels: ['cgao:plan-ready'],
        liveLabels: [], // human removed it
        expectsStatusComment: false,
        statusCommentBody: '',
      },
    ]);
    const { coordinator } = makeProjectionReconciler({
      issues,
      comments,
      labelPort: labels,
      audit,
      markerSecret: 'dev-secret',
    });
    const out = await coordinator.tick();
    expect(out.labelsRepaired).toBe(1);
    expect(labels.added).toContain('cgao:plan-ready');
    const chain = await audit.listByRun('run_2');
    expect(chain.some((r) => r.kind === 'label.set')).toBe(true);
  });

  it('removes spurious cgao: labels', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    const labels = new StubLabels();
    const issues = new StubReader([
      {
        runId: 'run_3',
        repo: 'cgao/test',
        issueNumber: 9,
        expectedLabels: [],
        liveLabels: ['cgao:merged', 'bug'], // bug should be left alone
        expectsStatusComment: false,
        statusCommentBody: '',
      },
    ]);
    const { coordinator } = makeProjectionReconciler({
      issues,
      comments,
      labelPort: labels,
      audit,
      markerSecret: 'dev-secret',
    });
    await coordinator.tick();
    expect(labels.removed).toContain('cgao:merged');
    expect(labels.removed).not.toContain('bug');
  });

  it('is idempotent on a clean issue', async () => {
    const audit = new InMemoryAuditChainService();
    const comments = new StubComments();
    // Comment already present.
    comments.listed = [{ id: 1, body: 'status\n\n<!-- cgao:status-comment -->' }];
    const labels = new StubLabels();
    const issues = new StubReader([
      {
        runId: 'run_4',
        repo: 'cgao/test',
        issueNumber: 10,
        expectedLabels: ['cgao:plan-ready'],
        liveLabels: ['cgao:plan-ready'],
        expectsStatusComment: true,
        statusCommentBody: 'status',
      },
    ]);
    const { coordinator } = makeProjectionReconciler({
      issues,
      comments,
      labelPort: labels,
      audit,
      markerSecret: 'dev-secret',
    });
    const out = await coordinator.tick();
    expect(out.commentsRecreated).toBe(0);
    expect(out.labelsRepaired).toBe(0);
    expect(comments.added.length).toBe(0);
    expect(labels.added.length).toBe(0);
  });
});

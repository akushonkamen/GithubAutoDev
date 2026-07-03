/**
 * T-M9-003 merge-ready comment renderer + StatusCommentUpdater.
 *
 * Contracts (spec §12.10 / §14.2 / §5):
 *   - Comment posted only when decision='merge'.
 *   - No `artifact://` URIs in the rendered body.
 *   - cgao's existing status comment is edited in place when found;
 *     otherwise a new one is created.
 *   - Only comments authored by the cgao bot are editable.
 */

import { describe, expect, it } from 'vitest';
import { renderMergeReadyBody } from '../merge-ready-renderer.js';
import {
  type PrComment,
  type StatusCommentBroker,
  StatusCommentUpdater,
} from '../status-comment-updater.js';
import type { AggregatedGates, MergeDecision } from '../types.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function makeAggregated(overrides: Partial<AggregatedGates> = {}): AggregatedGates {
  return {
    runId: 'run_1',
    headSha: HEAD,
    baseSha: BASE,
    mergeable: true,
    gates: {
      test: {
        kind: 'test',
        passed: true,
        reason: 'lint+typecheck+unit passed',
        evidenceRefs: ['sha256:test'],
        headSha: HEAD,
        baseSha: BASE,
      },
      ai_review: {
        kind: 'ai_review',
        passed: true,
        reason: 'reviewers passed',
        evidenceRefs: ['sha256:code', 'sha256:sec'],
        headSha: HEAD,
      },
      human_review: {
        kind: 'human_review',
        passed: true,
        reason: 'approved by alice',
        evidenceRefs: ['comment:1'],
        headSha: HEAD,
      },
      risk_policy: {
        kind: 'risk_policy',
        passed: true,
        reason: 'risk=low',
        evidenceRefs: [],
        headSha: HEAD,
      },
      security_findings: {
        kind: 'security_findings',
        passed: true,
        reason: '0 blocking findings',
        evidenceRefs: [],
        headSha: HEAD,
      },
    },
    excludedStale: [],
    ...overrides,
  };
}

function makeDecision(decision: MergeDecision['decision'] = 'merge'): MergeDecision {
  return {
    runId: 'run_1',
    prNumber: 1,
    decision,
    currentHeadSha: HEAD,
    testedHeadSha: HEAD,
    testedBaseSha: BASE,
    currentBaseSha: BASE,
    digest: 'sha256:'.concat('0'.repeat(64)),
    reasons: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

class StubBroker implements StatusCommentBroker {
  comments: PrComment[] = [];
  edited: { commentId: number; body: string }[] = [];
  created = 0;
  nextId = 100;
  setComments(c: PrComment[]) {
    this.comments = c;
    return this;
  }
  async listComments() {
    return this.comments;
  }
  async createComment(args: { repo: string; prNumber: number; body: string }) {
    const id = this.nextId++;
    this.comments.push({ id, body: args.body, authorLogin: 'cgao-bot[bot]' });
    this.created++;
    return { commentId: id };
  }
  async editComment(args: { repo: string; prNumber: number; commentId: number; body: string }) {
    const c = this.comments.find((x) => x.id === args.commentId);
    if (c) c.body = args.body;
    this.edited.push({ commentId: args.commentId, body: args.body });
  }
}

describe('T-M9-003 renderMergeReadyBody', () => {
  it('renders a markdown body without artifact:// URIs', () => {
    const body = renderMergeReadyBody({
      aggregated: makeAggregated(),
      prNumber: 42,
    });
    expect(body).not.toMatch(/artifact:\/\//u);
    expect(body).toContain('cgao: merge-ready');
    expect(body).toContain('PR #42');
  });

  it('throws if body accidentally contains artifact:// URI', () => {
    // Force one into the gate reason to trigger the guard.
    const a = makeAggregated({
      gates: {
        ...makeAggregated().gates,
        test: {
          kind: 'test',
          passed: true,
          reason: 'leak artifact://foo/bar',
          evidenceRefs: ['sha256:test'],
          headSha: HEAD,
          baseSha: BASE,
        },
      },
    });
    expect(() => renderMergeReadyBody({ aggregated: a, prNumber: 1 })).toThrow(/artifact:\/\//u);
  });

  it('includes a marker the StatusCommentUpdater can find', () => {
    const body = renderMergeReadyBody({
      aggregated: makeAggregated(),
      prNumber: 1,
    });
    expect(body).toContain('<!-- cgao:merge-ready');
    expect(body).toContain('run=run_1');
  });
});

describe('T-M9-003 StatusCommentUpdater', () => {
  it('does NOT post a comment when decision != merge', async () => {
    const broker = new StubBroker();
    const updater = new StatusCommentUpdater({
      broker,
      markerSecret: 's',
      cgaoBotLogin: 'cgao-bot[bot]',
    });
    const out = await updater.update({
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('refuse'),
      aggregated: makeAggregated(),
    });
    expect(out).toBeNull();
    expect(broker.created).toBe(0);
  });

  it('creates a new comment when no prior cgao merge-ready comment exists', async () => {
    const broker = new StubBroker();
    const updater = new StatusCommentUpdater({
      broker,
      markerSecret: 's',
      cgaoBotLogin: 'cgao-bot[bot]',
    });
    const out = await updater.update({
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      aggregated: makeAggregated(),
    });
    expect(out?.kind).toBe('created');
    expect(out?.body).not.toMatch(/artifact:\/\//u);
    expect(broker.created).toBe(1);
  });

  it('edits the existing cgao merge-ready comment in place', async () => {
    const broker = new StubBroker();
    broker.setComments([
      {
        id: 42,
        body: '<!-- cgao:merge-ready run=run_1 --> old body',
        authorLogin: 'cgao-bot[bot]',
      },
    ]);
    const updater = new StatusCommentUpdater({
      broker,
      markerSecret: 's',
      cgaoBotLogin: 'cgao-bot[bot]',
    });
    const out = await updater.update({
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      aggregated: makeAggregated(),
    });
    expect(out?.kind).toBe('updated');
    expect(out?.commentId).toBe(42);
    expect(broker.edited.length).toBe(1);
  });

  it('ignores comments authored by non-cgao accounts even if they spoof the marker', async () => {
    const broker = new StubBroker();
    broker.setComments([
      {
        id: 7,
        body: '<!-- cgao:merge-ready run=run_1 --> forged',
        authorLogin: 'attacker',
      },
    ]);
    const updater = new StatusCommentUpdater({
      broker,
      markerSecret: 's',
      cgaoBotLogin: 'cgao-bot[bot]',
    });
    const out = await updater.update({
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      aggregated: makeAggregated(),
    });
    // The forged comment is ignored; a fresh one is created instead.
    expect(out?.kind).toBe('created');
    expect(broker.edited.length).toBe(0);
  });
});

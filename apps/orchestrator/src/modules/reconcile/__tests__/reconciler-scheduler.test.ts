/**
 * T-M10-001 ReconcilerScheduler + drift event emission.
 */

import { InMemoryEventBus } from '@cgao/eventbus';
import { describe, expect, it } from 'vitest';
import { DriftDetector, type DbProjection } from '../drift-detector.js';
import {
  type InflightRun,
  type InflightRunReader,
  type ProjectionProvider,
  ReconcilerScheduler,
} from '../reconciler-scheduler.js';
import {
  type DriftReport,
  GitHubHydrator,
  type LiveIssueSnapshot,
  type LivePrSnapshot,
  type TrustedGithubHydrationPort,
} from '../github-hydrator.js';

class FakeReader implements InflightRunReader {
  constructor(private readonly runs: InflightRun[]) {}
  async listInflight(): Promise<readonly InflightRun[]> {
    return this.runs;
  }
}

class FakeGithub implements TrustedGithubHydrationPort {
  issue: LiveIssueSnapshot | null = null;
  pr: LivePrSnapshot | null = null;
  async fetchIssue(): Promise<LiveIssueSnapshot | null> {
    return this.issue;
  }
  async fetchPr(): Promise<LivePrSnapshot | null> {
    return this.pr;
  }
}

class FakeProjections implements ProjectionProvider {
  map = new Map<string, DbProjection>();
  async forRun(run: InflightRun): Promise<DbProjection> {
    return (
      this.map.get(run.id) ?? {
        runId: run.id,
        repo: `${run.repoOwner}/${run.repoName}`,
        issueNumber: run.issueNumber,
        prNumber: run.prNumber,
        expectedLabels: [],
        expectsStatusComment: false,
        expectedIssueState: 'open' as const,
        expectedHeadSha: null,
        expectedReviews: [],
        expectedChecks: [],
      }
    );
  }
}

function makeDeps() {
  const bus = new InMemoryEventBus();
  const github = new FakeGithub();
  const hydrator = new GitHubHydrator(github);
  const detector = new DriftDetector(bus);
  const projections = new FakeProjections();
  return { bus, github, hydrator, detector, projections };
}

describe('T-M10-001 ReconcilerScheduler', () => {
  it('skips overlapping ticks (idempotency)', async () => {
    const { bus, hydrator, detector, projections } = makeDeps();
    let slow = false;
    const reader = {
      async listInflight() {
        if (slow) {
          // simulate a long tick by yielding to the event loop
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        return [];
      },
    };
    const sched = new ReconcilerScheduler({
      bus,
      runs: reader,
      hydrator,
      detector,
      projections,
    });
    slow = true;
    const first = sched.tick();
    const second = sched.tick();
    const [r1, r2] = await Promise.all([first, second]);
    expect(r1).toBe(true);
    expect(r2).toBe(false); // overlap skipped
    slow = false;
  });

  it('hydrates each in-flight run and detects label drift', async () => {
    const { bus, github, hydrator, detector, projections } = makeDeps();
    const runs: InflightRun[] = [
      {
        id: 'run_1',
        repoOwner: 'cgao',
        repoName: 'test',
        issueNumber: 7,
        prNumber: null,
        state: 'PLAN_READY',
      },
    ];
    projections.map.set('run_1', {
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      prNumber: null,
      expectedLabels: ['cgao:plan-ready'],
      expectsStatusComment: true,
      expectedIssueState: 'open',
      expectedHeadSha: null,
      expectedReviews: [],
      expectedChecks: [],
    });
    github.issue = {
      repo: 'cgao/test',
      issueNumber: 7,
      labels: [], // label missing
      hasStatusComment: false, // comment missing
      state: 'open',
    };
    const sched = new ReconcilerScheduler({
      bus,
      runs: new FakeReader(runs),
      hydrator,
      detector,
      projections,
    });

    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      const kind = (m.payload as { kind: string }).kind;
      seen.push(kind);
    });

    await sched.tick();
    expect(seen).toContain('issue.label_mismatch');
    expect(seen).toContain('issue.status_comment_missing');
    expect(sched.tickCount).toBe(1);
  });

  it('emits pr.head_sha_divergence when force-push moves HEAD', async () => {
    const { bus, github, hydrator, detector, projections } = makeDeps();
    const runs: InflightRun[] = [
      {
        id: 'run_2',
        repoOwner: 'cgao',
        repoName: 'test',
        issueNumber: null,
        prNumber: 3,
        state: 'GATE',
      },
    ];
    projections.map.set('run_2', {
      runId: 'run_2',
      repo: 'cgao/test',
      issueNumber: null,
      prNumber: 3,
      expectedLabels: [],
      expectsStatusComment: false,
      expectedIssueState: 'open',
      expectedHeadSha: 'a'.repeat(40),
      expectedReviews: [],
      expectedChecks: [],
    });
    github.pr = {
      repo: 'cgao/test',
      prNumber: 3,
      headSha: 'b'.repeat(40),
      baseSha: 'c'.repeat(40),
      state: 'open',
      checks: [],
      reviews: [],
    };
    const sched = new ReconcilerScheduler({
      bus,
      runs: new FakeReader(runs),
      hydrator,
      detector,
      projections,
    });
    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      seen.push((m.payload as { kind: string }).kind);
    });
    await sched.tick();
    expect(seen).toContain('pr.head_sha_divergence');
  });

  it('start/stop schedules periodic ticks', () => {
    const { bus, hydrator, detector, projections } = makeDeps();
    const sched = new ReconcilerScheduler({
      bus,
      runs: new FakeReader([]),
      hydrator,
      detector,
      projections,
      periodMs: 5,
    });
    sched.start();
    expect(sched.isRunning).toBe(false);
    sched.stop();
  });
});

// re-export for type narrowing in tests
export type { DriftReport };

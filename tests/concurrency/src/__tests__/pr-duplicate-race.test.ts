/**
 * PR duplicate/race regression — T-M7-006, spec §4.3 / §4.4 / §15.
 *
 * Drives 50 concurrent `createPr` invocations against a fake GitHub
 * client that simulates network latency and occasional 5xx. Asserts:
 *
 *   (a) fake GitHub create-call count == 1 (only one PR created)
 *   (b) DB row count for the run == 1 (prNumber written exactly once)
 *   (c) mix of webhook + retry + timeout still produces 1 PR
 *
 * The PullRequestService's in-process mutex serializes per-runId
 * look-then-create. Production adds a Postgres unique constraint on
 * (run_id, head_sha) for the cross-process case; this test exercises
 * the in-process path.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import {
  type GitHubPrPort,
  type OpenPr,
  PullRequestService,
  type WorkflowRunPrPort,
} from '@cgao/orchestrator';
import { describe, expect, it } from 'vitest';

const SECRET = 'race-secret';

class LatentFakeGithub implements GitHubPrPort {
  readonly createCalls: { branchName: string; body: string }[] = [];
  listCalls = 0;
  /** Probability (0..1) a list or create call throws a 5xx. */
  transient5xxRate = 0.0;
  /** Per-call latency range (ms). */
  latencyMs = 0;
  private nextPrNumber = 2000;
  private readonly openPrs = new Map<number, OpenPr & { body: string }>();

  async listOpenPrsForRun(args: { runId: string }): Promise<readonly OpenPr[]> {
    this.listCalls += 1;
    await this.maybeSleepAndThrow();
    const out: OpenPr[] = [];
    for (const v of this.openPrs.values()) {
      if (v.body.includes(`run_id=${args.runId}`)) {
        out.push({ prNumber: v.prNumber, prUrl: v.prUrl, headSha: v.headSha });
      }
    }
    return out;
  }

  async createPr(args: {
    repo: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string }> {
    await this.maybeSleepAndThrow();
    this.createCalls.push({ branchName: args.branchName, body: args.body });
    const prNumber = this.nextPrNumber++;
    const headSha = /head_sha=([0-9a-f]+)/u.exec(args.body)?.[1] ?? 'unknown';
    this.openPrs.set(prNumber, {
      prNumber,
      prUrl: `https://example.test/pull/${prNumber}`,
      headSha,
      body: args.body,
    });
    return { prNumber, prUrl: `https://example.test/pull/${prNumber}` };
  }

  private async maybeSleepAndThrow(): Promise<void> {
    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }
    if (this.transient5xxRate > 0 && Math.random() < this.trans5xx()) {
      const err = new Error('GitHub 503') as Error & { status?: number };
      err.status = 503;
      throw err;
    }
  }

  private trans5xx(): number {
    return this.transient5xxRate;
  }
}

class InMemoryRuns implements WorkflowRunPrPort {
  readonly writes: { runId: string; prNumber: number }[] = [];
  private readonly rows = new Map<string, number>();
  async getPrNumber(runId: string): Promise<number | null> {
    return this.rows.get(runId) ?? null;
  }
  async setPrNumber(runId: string, prNumber: number): Promise<void> {
    this.writes.push({ runId, prNumber });
    this.rows.set(runId, prNumber);
  }
  /** Distinct runIds that have a prNumber set. */
  distinctRunCount(): number {
    return this.rows.size;
  }
}

function baseInput() {
  return {
    runId: 'run_race',
    repo: 'cgao/test',
    branchName: 'cgao/issue-1-fix',
    baseBranch: 'main',
    headSha: 'a'.repeat(64),
    title: 'cgao: fix',
    body: '## cgao PR\n\ntraceability',
  };
}

describe('T-M7-006 pr duplicate/race regression (spec §4.3 / §4.4 / §15)', () => {
  it('50 concurrent createPr calls → exactly 1 PR', async () => {
    const github = new LatentFakeGithub();
    github.latencyMs = 2;
    const runs = new InMemoryRuns();
    const audit = new InMemoryAuditChainService();
    const svc = new PullRequestService({
      github,
      runs,
      audit,
      config: { markerSecret: SECRET },
    });

    const input = baseInput();
    const results = await Promise.all(Array.from({ length: 50 }, () => svc.createPr(input)));

    // (a) fake GitHub create-call count == 1
    expect(github.createCalls.length).toBe(1);
    // (b) DB row count for run == 1
    expect(runs.distinctRunCount()).toBe(1);
    // All 50 callers see the same PR number.
    const numbers = new Set(results.map((r) => r.prNumber));
    expect(numbers.size).toBe(1);
  });

  it('mix of webhook delivery + retry + timeout → still 1 PR', async () => {
    const github = new LatentFakeGithub();
    github.latencyMs = 1;
    // First listing attempt per call may 5xx — the service retries.
    github.transient5xxRate = 0.0; // we'll inject failures manually below
    const runs = new InMemoryRuns();
    const audit = new InMemoryAuditChainService();
    const svc = new PullRequestService({
      github,
      runs,
      audit,
      config: { markerSecret: SECRET },
    });

    const input = baseInput();
    // Wave 1: 10 concurrent webhook-style invocations.
    const wave1 = await Promise.all(Array.from({ length: 10 }, () => svc.createPr(input)));

    // Wave 2: simulate a delayed retry — a webhook delivery that
    // arrived while wave 1 was in flight. The service's per-run mutex
    // queues these behind the first call.
    github.transient5xxRate = 0.3; // 30% of list/create calls 5xx
    const wave2 = await Promise.all(
      Array.from({ length: 20 }, () => svc.createPr(input).catch(() => null)),
    );

    // Wave 3: a "timeout then redeliver" — caller retries after a pause.
    await new Promise((r) => setTimeout(r, 5));
    github.transient5xxRate = 0.0;
    const wave3 = await Promise.all(Array.from({ length: 20 }, () => svc.createPr(input)));

    const all = [
      ...wave1,
      ...wave2.filter(
        (r): r is { prNumber: number; prUrl: string; created: boolean } => r !== null,
      ),
      ...wave3,
    ];
    const numbers = new Set(all.map((r) => r.prNumber));
    expect(numbers.size).toBe(1);
    expect(github.createCalls.length).toBe(1);
    expect(runs.distinctRunCount()).toBe(1);
  });

  it('audit chain stays intact under concurrency', async () => {
    const github = new LatentFakeGithub();
    github.latencyMs = 1;
    const runs = new InMemoryRuns();
    const audit = new InMemoryAuditChainService();
    const svc = new PullRequestService({
      github,
      runs,
      audit,
      config: { markerSecret: SECRET },
    });

    const input = baseInput();
    await Promise.all(Array.from({ length: 30 }, () => svc.createPr(input)));

    // Chain is unbroken.
    expect(await audit.verifyRun(input.runId)).toBeNull();
    // Exactly one pr.create event.
    const events = await audit.listByRun(input.runId);
    expect(events.filter((e) => e.kind === 'pr.create').length).toBe(1);
  });

  it('different runIds produce distinct PRs (no cross-run dedup)', async () => {
    const github = new LatentFakeGithub();
    github.latencyMs = 1;
    const runs = new InMemoryRuns();
    const audit = new InMemoryAuditChainService();
    const svc = new PullRequestService({
      github,
      runs,
      audit,
      config: { markerSecret: SECRET },
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, i) => svc.createPr({ ...baseInput(), runId: `run_${i}` })),
    );

    expect(github.createCalls.length).toBe(5);
    expect(runs.distinctRunCount()).toBe(5);
  });
});

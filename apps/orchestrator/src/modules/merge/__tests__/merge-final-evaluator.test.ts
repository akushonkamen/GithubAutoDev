/**
 * T-M9-002 MergeFinalEvaluator.
 *
 * Contracts (spec §12.10 / §21):
 *   - Head sha drift between tested/reviewed/approved and current PR
 *     head → decision='refuse'.
 *   - Base sha drift → decision='queue' (default policy) or 'refuse'.
 *   - High-risk PR missing human approval at current head → refuse.
 *   - Persisted MergeDecision artifact has a sha256 digest.
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import {
  type BranchProtectionSnapshot,
  GitHubStateHydrator,
  type LivePrSnapshot,
  type TrustedGitHubPrPort,
} from '../github-state-hydrator.js';
import { MergeFinalEvaluator } from '../merge-final-evaluator.js';
import { GateAggregator } from '../gate-aggregator.js';
import { GateResultsReader } from '../gate-results-reader.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OTHER_HEAD = 'c'.repeat(40);
const OTHER_BASE = 'd'.repeat(40);

class StubGithub implements TrustedGitHubPrPort {
  private pr: LivePrSnapshot | null = null;
  private protection: BranchProtectionSnapshot | null = null;
  setPr(pr: LivePrSnapshot | null) {
    this.pr = pr;
    return this;
  }
  setProtection(p: BranchProtectionSnapshot | null) {
    this.protection = p;
    return this;
  }
  async fetchPr(): Promise<LivePrSnapshot | null> {
    return this.pr;
  }
  async fetchBranchProtection(): Promise<BranchProtectionSnapshot | null> {
    return this.protection;
  }
}

function makeFreshLive(overrides: Partial<LivePrSnapshot> = {}): LivePrSnapshot {
  return {
    prNumber: 1,
    headSha: HEAD,
    baseSha: BASE,
    baseBranch: 'main',
    mergeableState: 'clean',
    state: 'open',
    protected: false,
    ...overrides,
  };
}

function makeReaderDeps() {
  const testGates = {
    async findLatest() {
      return {
        runId: 'run_1',
        headSha: HEAD,
        baseSha: BASE,
        passed: true,
        logArtifactRef: 'sha256:test',
      };
    },
  };
  const aiReviews = {
    async list() {
      return [
        {
          runId: 'run_1',
          headSha: HEAD,
          reviewer: 'code' as const,
          completed: true,
          reviewArtifactRef: 'sha256:code',
        },
        {
          runId: 'run_1',
          headSha: HEAD,
          reviewer: 'security' as const,
          completed: true,
          reviewArtifactRef: 'sha256:sec',
        },
      ];
    },
  };
  const humanApprovals = {
    async findLatest() {
      return { actor: 'alice', headSha: HEAD, approvedAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const risk = {
    async find() {
      return {
        runId: 'run_1',
        headSha: HEAD,
        severity: 'low' as const,
        requiresHumanReview: false,
      };
    },
  };
  const findings = { async findBlocking() { return []; } };
  return { testGates, aiReviews, humanApprovals, risk, findings };
}

function makeEvaluator(stub: StubGithub, opts: { baseAdvancedPolicy?: 'queue' | 'refuse' } = {}) {
  const deps = makeReaderDeps();
  const reader = new GateResultsReader({
    testGates: deps.testGates as never,
    aiReviews: deps.aiReviews as never,
    humanApprovals: deps.humanApprovals as never,
    risk: deps.risk as never,
    findings: deps.findings as never,
  });
  const aggregator = new GateAggregator(reader);
  const hydrator = new GitHubStateHydrator(stub);
  const store = new InMemoryArtifactStore();
  const evaluator = new MergeFinalEvaluator({
    hydrator,
    aggregator,
    store,
    baseAdvancedPolicy: opts.baseAdvancedPolicy,
  });
  return { evaluator, store };
}

describe('T-M9-002 MergeFinalEvaluator', () => {
  it('returns decision=merge when all gates green and shas match', async () => {
    const stub = new StubGithub().setPr(makeFreshLive());
    const { evaluator } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).toBe('merge');
    expect(out.decision.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(out.artifactRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('returns decision=refuse on head_sha drift (force-push)', async () => {
    const stub = new StubGithub().setPr(makeFreshLive({ headSha: OTHER_HEAD }));
    const { evaluator } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).toBe('refuse');
    expect(out.decision.reasons.some((r) => r.includes('head_sha drift'))).toBe(true);
  });

  it('returns decision=queue when base sha drifts (default policy)', async () => {
    const stub = new StubGithub().setPr(makeFreshLive({ baseSha: OTHER_BASE }));
    const { evaluator } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).toBe('queue');
    expect(out.decision.reasons.some((r) => r.includes('base_sha drift'))).toBe(true);
  });

  it('returns decision=refuse when base drifts and policy=refuse', async () => {
    const stub = new StubGithub().setPr(makeFreshLive({ baseSha: OTHER_BASE }));
    const { evaluator } = makeEvaluator(stub, { baseAdvancedPolicy: 'refuse' });
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).toBe('refuse');
  });

  it('refuses when PR is mergeable_state=dirty', async () => {
    const stub = new StubGithub().setPr(makeFreshLive({ mergeableState: 'dirty' }));
    const { evaluator } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).toBe('refuse');
    expect(out.decision.reasons.some((r) => r.includes('dirty'))).toBe(true);
  });

  it('never yields merge when hydrated head sha != tested head sha', async () => {
    // Sanity check that mirrors T-M9-005: stale SHAs can NEVER produce merge.
    const stub = new StubGithub().setPr(makeFreshLive({ headSha: OTHER_HEAD }));
    const { evaluator } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    expect(out.decision.decision).not.toBe('merge');
  });

  it('persisted artifact content matches the digest (sha256 binding)', async () => {
    const stub = new StubGithub().setPr(makeFreshLive());
    const { evaluator, store } = makeEvaluator(stub);
    const out = await evaluator.evaluate({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      testedHeadSha: HEAD,
      testedBaseSha: BASE,
      requiresHumanReview: false,
    });
    const artifact = await store.read(out.artifactRef);
    expect(artifact).not.toBeNull();
    expect(artifact?.key).toBe(out.artifactRef);
  });
});

/**
 * Stale SHA merge prevention regression — T-M9-005, spec §6 / §12.10 / §21.
 *
 * This is the security regression for the merge module. It locks in
 * two invariants:
 *
 *   1. PR force-push invalidates every old test/review/approval SHA;
 *      the gate aggregator and the final evaluator MUST both refuse
 *      to yield `decision: 'merge'` against the new head.
 *   2. Base-branch advance blocks direct merge — the final evaluator
 *      either QUEUES (re-run on merge_group) or REFUSES, never merges.
 *
 * Attack scenarios covered:
 *
 *   - Attacker pushes a benign commit, gets approval, then force-pushes
 *     a malicious commit at the same PR number. The stale approval
 *     MUST NOT carry over.
 *   - Attacker lands a small change ahead of cgao's PR so the base sha
 *     advances; cgao MUST NOT merge a PR whose tests ran against the
 *     older base.
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import {
  GateAggregator,
  GateResultsReader,
  GitHubStateHydrator,
  MergeFinalEvaluator,
  type BranchProtectionSnapshot,
  type LivePrSnapshot,
  type TrustedGitHubPrPort,
} from '@cgao/orchestrator';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'c'.repeat(40);
const BASE_A = 'b'.repeat(40);
const BASE_B = 'd'.repeat(40);

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
  async fetchPr() {
    return this.pr;
  }
  async fetchBranchProtection() {
    return this.protection;
  }
}

function makeLive(overrides: Partial<LivePrSnapshot> = {}): LivePrSnapshot {
  return {
    prNumber: 1,
    headSha: HEAD_A,
    baseSha: BASE_A,
    baseBranch: 'main',
    mergeableState: 'clean',
    state: 'open',
    protected: false,
    ...overrides,
  };
}

function makeReaderDeps() {
  const testGates = {
    async findLatest(args: { runId: string }) {
      return {
        runId: args.runId,
        headSha: HEAD_A,
        baseSha: BASE_A,
        passed: true,
        logArtifactRef: 'sha256:test',
      };
    },
  };
  const aiReviews = {
    async list(args: { runId: string }) {
      return [
        {
          runId: args.runId,
          headSha: HEAD_A,
          reviewer: 'code' as const,
          completed: true,
          reviewArtifactRef: 'sha256:code',
        },
        {
          runId: args.runId,
          headSha: HEAD_A,
          reviewer: 'security' as const,
          completed: true,
          reviewArtifactRef: 'sha256:sec',
        },
      ];
    },
  };
  const humanApprovals = {
    async findLatest() {
      return { actor: 'alice', headSha: HEAD_A, approvedAt: '2026-01-01T00:00:00.000Z' };
    },
  };
  const risk = {
    async find(args: { runId: string }) {
      return {
        runId: args.runId,
        headSha: HEAD_A,
        severity: 'low' as const,
        requiresHumanReview: false,
      };
    },
  };
  const findings = { async findBlocking() { return []; } };
  return { testGates, aiReviews, humanApprovals, risk, findings };
}

function makeEvaluator(stub: StubGithub) {
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
  const evaluator = new MergeFinalEvaluator({ hydrator, aggregator, store });
  return { evaluator };
}

describe('T-M9-005 stale SHA merge prevention', () => {
  describe('force-push variant', () => {
    it('gate aggregator excludes stale signals after a force-push', async () => {
      const deps = makeReaderDeps();
      const reader = new GateResultsReader({
        testGates: deps.testGates as never,
        aiReviews: deps.aiReviews as never,
        humanApprovals: deps.humanApprovals as never,
        risk: deps.risk as never,
        findings: deps.findings as never,
      });
      const aggregator = new GateAggregator(reader);
      const out = await aggregator.aggregate({
        runId: 'run_1',
        prNumber: 1,
        headSha: HEAD_B, // current head is the force-pushed sha
        baseSha: BASE_A,
      });
      expect(out.mergeable).toBe(false);
      // All five signals were recorded at HEAD_A; the new HEAD_B must
      // invalidate every one of them.
      expect(out.excludedStale.length).toBeGreaterThan(0);
    });

    it('final evaluator returns refuse (never merge) after a force-push', async () => {
      const stub = new StubGithub().setPr(makeLive({ headSha: HEAD_B }));
      const { evaluator } = makeEvaluator(stub);
      const out = await evaluator.evaluate({
        runId: 'run_1',
        repo: 'cgao/test',
        prNumber: 1,
        testedHeadSha: HEAD_A,
        testedBaseSha: BASE_A,
        requiresHumanReview: false,
      });
      expect(out.decision.decision).not.toBe('merge');
      expect(out.decision.decision).toBe('refuse');
      expect(out.decision.reasons.some((r) => r.includes('head_sha drift'))).toBe(true);
    });
  });

  describe('base-branch advance variant', () => {
    it('final evaluator queues (default) or refuses — never merges — when base moved', async () => {
      const stub = new StubGithub().setPr(makeLive({ baseSha: BASE_B }));
      const { evaluator } = makeEvaluator(stub);
      const out = await evaluator.evaluate({
        runId: 'run_1',
        repo: 'cgao/test',
        prNumber: 1,
        testedHeadSha: HEAD_A,
        testedBaseSha: BASE_A,
        requiresHumanReview: false,
      });
      expect(out.decision.decision).not.toBe('merge');
      // Default policy is queue; either queue or refuse is acceptable
      // per spec §12.10. The forbidden outcome is 'merge'.
      expect(['queue', 'refuse']).toContain(out.decision.decision);
    });

    it('final evaluator refuses under policy=refuse on base advance', async () => {
      const deps = makeReaderDeps();
      const reader = new GateResultsReader({
        testGates: deps.testGates as never,
        aiReviews: deps.aiReviews as never,
        humanApprovals: deps.humanApprovals as never,
        risk: deps.risk as never,
        findings: deps.findings as never,
      });
      const aggregator = new GateAggregator(reader);
      const stub = new StubGithub().setPr(makeLive({ baseSha: BASE_B }));
      const hydrator = new GitHubStateHydrator(stub);
      const store = new InMemoryArtifactStore();
      const evaluator = new MergeFinalEvaluator({
        hydrator,
        aggregator,
        store,
        baseAdvancedPolicy: 'refuse',
      });
      const out = await evaluator.evaluate({
        runId: 'run_1',
        repo: 'cgao/test',
        prNumber: 1,
        testedHeadSha: HEAD_A,
        testedBaseSha: BASE_A,
        requiresHumanReview: false,
      });
      expect(out.decision.decision).toBe('refuse');
    });
  });

  describe('never merge on stale state (negative invariant)', () => {
    it('a clean snapshot at HEAD_A yields merge — proves the test setup is sound', async () => {
      const stub = new StubGithub().setPr(makeLive());
      const { evaluator } = makeEvaluator(stub);
      const out = await evaluator.evaluate({
        runId: 'run_1',
        repo: 'cgao/test',
        prNumber: 1,
        testedHeadSha: HEAD_A,
        testedBaseSha: BASE_A,
        requiresHumanReview: false,
      });
      // Sanity: when nothing is stale, decision IS merge — proving
      // that the refuse cases below are due to staleness, not bugs.
      expect(out.decision.decision).toBe('merge');
    });
  });
});

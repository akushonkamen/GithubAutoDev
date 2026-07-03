/**
 * T-M9-001 GateAggregator + GateResultsReader + PolicyDecisionWriter.
 *
 * Contracts (spec §12.10):
 *   - Five gate kinds are aggregated: test, ai_review, human_review,
 *     risk_policy, security_findings.
 *   - All gates are bound to head_sha + base_sha; mismatched gates are
 *     excluded and surfaced in excludedStale.
 *   - mergeable=true requires EVERY required gate to have passed.
 *   - High-risk PRs additionally require the human_review gate.
 */

import { describe, expect, it } from 'vitest';
import { GateResultsReader } from '../gate-results-reader.js';
import type {
  AiReviewLookup,
  AiReviewRecord,
  HumanApprovalLookup,
  HumanApprovalRecord,
  RiskClassificationLookup,
  RiskClassificationRecord,
  TestGateLookup,
  TestGateRecord,
} from '../gate-results-reader.js';
import { GateAggregator } from '../gate-aggregator.js';
import {
  PolicyDecisionWriter,
  type PolicyDecisionRecord,
  type PolicyDecisionRepository,
} from '../policy-decision-writer.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const OLD_HEAD = 'c'.repeat(40);
const OLD_BASE = 'd'.repeat(40);

class FakeTestGates implements TestGateLookup {
  private rows = new Map<string, TestGateRecord>();
  set(r: TestGateRecord) {
    this.rows.set(r.runId, r);
    return this;
  }
  async findLatest(args: { runId: string }): Promise<TestGateRecord | null> {
    return this.rows.get(args.runId) ?? null;
  }
}

class FakeAiReviews implements AiReviewLookup {
  private rows: AiReviewRecord[] = [];
  set(r: AiReviewRecord) {
    this.rows.push(r);
    return this;
  }
  async list(args: { runId: string }): Promise<readonly AiReviewRecord[]> {
    return this.rows.filter((r) => r.runId === args.runId);
  }
}

class FakeHumanApprovals implements HumanApprovalLookup {
  private latest: HumanApprovalRecord | null = null;
  set(r: HumanApprovalRecord | null) {
    this.latest = r;
    return this;
  }
  async findLatest(): Promise<HumanApprovalRecord | null> {
    return this.latest;
  }
}

class FakeRisk implements RiskClassificationLookup {
  private row: RiskClassificationRecord | null = null;
  set(r: RiskClassificationRecord | null) {
    this.row = r;
    return this;
  }
  async find(): Promise<RiskClassificationRecord | null> {
    return this.row;
  }
}

class InMemoryPolicyDecisions implements PolicyDecisionRepository {
  readonly rows: PolicyDecisionRecord[] = [];
  async insert(r: PolicyDecisionRecord): Promise<void> {
    this.rows.push(r);
  }
}

function makeReader(overrides: Partial<{
  test: FakeTestGates;
  ai: FakeAiReviews;
  human: FakeHumanApprovals;
  risk: FakeRisk;
  blocking: { findBlocking(prNumber: number): Promise<readonly { id: string; headSha: string }[]> };
}> = {}) {
  const test = overrides.test ?? new FakeTestGates();
  const ai = overrides.ai ?? new FakeAiReviews();
  const human = overrides.human ?? new FakeHumanApprovals();
  const risk = overrides.risk ?? new FakeRisk();
  const findings =
    overrides.blocking ??
    ({ async findBlocking() { return []; } } as unknown as {
      findBlocking(prNumber: number): Promise<readonly { id: string; headSha: string }[]>;
    });
  const reader = new GateResultsReader({
    testGates: test,
    aiReviews: ai,
    humanApprovals: human,
    risk,
    findings: findings as never,
  });
  return { reader, test, ai, human, risk, findings };
}

describe('T-M9-001 GateResultsReader', () => {
  it('drops stale test-gate signal whose head/base mismatch current', async () => {
    const { reader, test } = makeReader();
    test.set({
      runId: 'run_1',
      headSha: OLD_HEAD,
      baseSha: OLD_BASE,
      passed: true,
      logArtifactRef: 'sha256:'.concat('0'.repeat(64)),
    });
    const out = await reader.read({
      runId: 'run_1',
      prNumber: 1,
      currentHeadSha: HEAD,
      currentBaseSha: BASE,
    });
    expect(out.evaluations.test?.passed).toBe(false);
    expect(out.evaluations.test?.headSha).toBe(HEAD);
    expect(out.excludedStale.some((e) => e.kind === 'test')).toBe(true);
  });

  it('drops stale AI review at a different head sha', async () => {
    const { reader, ai } = makeReader();
    ai.set({
      runId: 'run_1',
      headSha: OLD_HEAD,
      reviewer: 'code',
      completed: true,
      reviewArtifactRef: 'sha256:1',
    });
    const out = await reader.read({
      runId: 'run_1',
      prNumber: 1,
      currentHeadSha: HEAD,
      currentBaseSha: BASE,
    });
    expect(out.evaluations.ai_review?.passed).toBe(false);
    expect(out.excludedStale.some((e) => e.kind === 'ai_review')).toBe(true);
  });

  it('drops stale human approval recorded against a different head', async () => {
    const { reader, human } = makeReader();
    human.set({
      actor: 'alice',
      headSha: OLD_HEAD,
      approvedAt: '2026-01-01T00:00:00.000Z',
      sourceRef: 'comment:1',
    });
    const out = await reader.read({
      runId: 'run_1',
      prNumber: 1,
      currentHeadSha: HEAD,
      currentBaseSha: BASE,
    });
    expect(out.evaluations.human_review?.passed).toBe(false);
    expect(out.excludedStale.some((e) => e.kind === 'human_review')).toBe(true);
  });
});

describe('T-M9-001 GateAggregator', () => {
  it('reports mergeable=true when all five gates are green at the current head', async () => {
    const { reader, test, ai, human, risk } = makeReader();
    test.set({
      runId: 'run_1',
      headSha: HEAD,
      baseSha: BASE,
      passed: true,
      logArtifactRef: 'sha256:test',
    });
    ai.set({
      runId: 'run_1',
      headSha: HEAD,
      reviewer: 'code',
      completed: true,
      reviewArtifactRef: 'sha256:code',
    });
    ai.set({
      runId: 'run_1',
      headSha: HEAD,
      reviewer: 'security',
      completed: true,
      reviewArtifactRef: 'sha256:sec',
    });
    human.set({
      actor: 'alice',
      headSha: HEAD,
      approvedAt: '2026-01-01T00:00:00.000Z',
    });
    risk.set({
      runId: 'run_1',
      headSha: HEAD,
      severity: 'low',
      requiresHumanReview: false,
    });
    const agg = new GateAggregator(reader);
    const result = await agg.aggregate({
      runId: 'run_1',
      prNumber: 1,
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(result.mergeable).toBe(true);
    expect(Object.keys(result.gates).length).toBe(5);
    expect(result.excludedStale).toEqual([]);
  });

  it('reports mergeable=false when a stale signal is excluded', async () => {
    const { reader, test } = makeReader();
    test.set({
      runId: 'run_1',
      headSha: OLD_HEAD,
      baseSha: OLD_BASE,
      passed: true,
      logArtifactRef: 'sha256:test',
    });
    const agg = new GateAggregator(reader);
    const result = await agg.aggregate({
      runId: 'run_1',
      prNumber: 1,
      headSha: HEAD,
      baseSha: BASE,
    });
    expect(result.mergeable).toBe(false);
    expect(result.excludedStale.length).toBeGreaterThan(0);
    expect(result.gates.test?.passed).toBe(false);
  });

  it('forces human_review gate red when requiresHumanReview is set and approval missing', async () => {
    const { reader, risk } = makeReader();
    risk.set({
      runId: 'run_1',
      headSha: HEAD,
      severity: 'high',
      requiresHumanReview: true,
    });
    const agg = new GateAggregator(reader);
    const result = await agg.aggregate({
      runId: 'run_1',
      prNumber: 1,
      headSha: HEAD,
      baseSha: BASE,
      requiresHumanReview: true,
    });
    expect(result.gates.human_review?.passed).toBe(false);
    expect(result.mergeable).toBe(false);
  });
});

describe('T-M9-001 PolicyDecisionWriter', () => {
  it('writes one PolicyDecision row per gate kind', async () => {
    const repo = new InMemoryPolicyDecisions();
    const writer = new PolicyDecisionWriter(repo);
    await writer.write({
      runId: 'run_1',
      aggregated: {
        runId: 'run_1',
        headSha: HEAD,
        baseSha: BASE,
        mergeable: true,
        gates: {
          test: {
            kind: 'test',
            passed: true,
            reason: 'ok',
            evidenceRefs: [],
            headSha: HEAD,
            baseSha: BASE,
          },
          ai_review: {
            kind: 'ai_review',
            passed: true,
            reason: 'ok',
            evidenceRefs: [],
            headSha: HEAD,
            baseSha: BASE,
          },
          human_review: {
            kind: 'human_review',
            passed: true,
            reason: 'ok',
            evidenceRefs: [],
            headSha: HEAD,
          },
          risk_policy: {
            kind: 'risk_policy',
            passed: true,
            reason: 'ok',
            evidenceRefs: [],
            headSha: HEAD,
          },
          security_findings: {
            kind: 'security_findings',
            passed: true,
            reason: 'ok',
            evidenceRefs: [],
            headSha: HEAD,
          },
        },
        excludedStale: [],
      },
      requiresHumanReview: false,
    });
    expect(repo.rows.length).toBe(5);
    expect(repo.rows.every((r) => r.decision === 'allow')).toBe(true);
  });

  it('emits an extra deny record for high-risk PRs missing human review', async () => {
    const repo = new InMemoryPolicyDecisions();
    const writer = new PolicyDecisionWriter(repo);
    await writer.write({
      runId: 'run_1',
      aggregated: {
        runId: 'run_1',
        headSha: HEAD,
        baseSha: BASE,
        mergeable: false,
        gates: {
          test: undefined,
          ai_review: undefined,
          human_review: {
            kind: 'human_review',
            passed: false,
            reason: 'missing',
            evidenceRefs: [],
            headSha: HEAD,
          },
          risk_policy: undefined,
          security_findings: undefined,
        },
        excludedStale: [],
      },
      requiresHumanReview: true,
    });
    const highRiskRecord = repo.rows.find((r) =>
      (r.reason as { gate?: string }).gate === 'high_risk_human_review_required',
    );
    expect(highRiskRecord).toBeDefined();
    expect(highRiskRecord?.decision).toBe('deny');
  });
});

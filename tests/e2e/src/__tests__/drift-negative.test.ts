/**
 * T-E2E-005 — Drift / stale-SHA negative regression.
 *
 * Mirrors the happy path up to the merge gate, then forces a
 * `current_head_sha ≠ tested_head_sha` mid-flow (force-push) and
 * asserts MergeFinalEvaluator yields `decision: 'refuse'`.
 *
 * This is the spec §12.10 / §21 stale-SHA invariant: a force-push
 * between gate-pass and merge MUST NOT carry old approvals forward.
 */

import { randomUUID } from 'node:crypto';
import {
  type BranchProtectionSnapshot,
  GateAggregator,
  GateResultsReader,
  type ImplementationPlan,
  type ImplementationTask,
  MergeFinalEvaluator,
  type RequirementSpec,
  buildImplementationPlan,
  generateRequirementSpec,
} from '@cgao/orchestrator';
import { beforeEach, describe, expect, it } from 'vitest';
import { type HappyPathFixture, buildHappyPathFixture } from '../fixtures/happy-path-fixture.js';

const REPO = 'cgao/test';
const ISSUE_NUMBER = 43;
const RUN_ID = `run_${randomUUID()}`;

describe('T-E2E-005 — head-SHA drift refuses merge', () => {
  let fx: HappyPathFixture;

  beforeEach(() => {
    fx = buildHappyPathFixture({
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      controlToken: 'e2e-control-token',
      baseSha: '0'.repeat(40),
    });
  });

  it('refuses merge after force-push between gate-pass and merge', async () => {
    // Build a spec + plan (same as happy path; truncated for brevity).
    const snapshot = {
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      title: 'Drift test',
      body: 'Negative regression for head sha drift.',
      labels: ['cgao:new'],
      authorLogin: 'alice',
    };

    const spec: RequirementSpec = generateRequirementSpec({
      snapshot,
      extracted: {
        summary: 'Drift negative test',
        goals: ['Drift regression'],
        acceptanceCriteria: [{ description: 'Criterion', verification: 'manual' }],
      },
    });

    const tasks: ImplementationTask[] = [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'Single task.',
        allowedPaths: ['src/x.ts'],
        forbiddenPaths: [],
        dependsOn: [],
        agent: 'implementer',
        modelTier: 'standard',
      },
    ];

    const plan: ImplementationPlan = buildImplementationPlan({
      spec,
      requirementSpecDigest: spec.issueSnapshotSha,
      tasks,
      planId: 'plan-drift',
      generation: spec.generation,
    });

    // Create branch + commit (sha A).
    const branch = await fx.branchService.create({
      runId: RUN_ID,
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      slug: 'drift-test',
    });

    const baseTree = new Map<string, string>([['src/x.ts', 'old\n']]);
    fx.fakeGit.seedBaseTree(branch.branchName, baseTree);

    const commitResult = await fx.commitBuilder.build({
      runId: RUN_ID,
      branchName: branch.branchName,
      patch: {
        baseSha: branch.baseSha,
        entries: [{ path: 'src/x.ts', contents: 'export const x = 1;\n', deleted: false }],
        allowedPaths: ['src/x.ts'],
        forbiddenPaths: [],
      },
      message: {
        summary: 'drift test commit',
        issueNumber: ISSUE_NUMBER,
        runId: RUN_ID,
        specId: spec.issueSnapshotSha,
        planId: plan.planId,
        planSha: plan.planSha,
      },
      base: baseTree,
    });

    expect(commitResult.decision).toBe('committed');
    if (!commitResult.commitSha) throw new Error('commitSha missing');
    const testedHeadSha = commitResult.commitSha.slice('sha256:'.length).slice(0, 40);
    const baseSha40 = branch.baseSha;

    // Create the PR via the fake GitHub client.
    fx.fakeGitHub.prepareNextPr({ runId: RUN_ID, headSha: testedHeadSha });
    await fx.workflowRuns.create({
      id: RUN_ID,
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: ISSUE_NUMBER,
      state: 'implementing',
      riskLevel: 'low',
    });
    const pr = await fx.prService.createPr({
      runId: RUN_ID,
      repo: REPO,
      branchName: branch.branchName,
      baseBranch: 'main',
      headSha: testedHeadSha,
      title: 'drift test',
      body: 'drift test body',
    });

    // Force-push: override the live PR's head sha to a different sha.
    const attackerSha = 'd'.repeat(40);
    fx.fakeGitHub.forcePush(pr.prNumber, attackerSha);

    // Wire a passing gate reader bound to the OLD head sha — the
    // gate thinks everything is green; the hydrator + final evaluator
    // must still catch the drift.
    const passingReader = new GateResultsReader({
      testGates: {
        async findLatest() {
          return {
            runId: RUN_ID,
            headSha: testedHeadSha,
            baseSha: baseSha40,
            passed: true,
            logArtifactRef: 'log:fast-gate',
          };
        },
      },
      aiReviews: {
        async list() {
          return [
            {
              runId: RUN_ID,
              headSha: testedHeadSha,
              reviewer: 'code',
              completed: true,
              reviewArtifactRef: 'log:code-review',
            },
            {
              runId: RUN_ID,
              headSha: testedHeadSha,
              reviewer: 'security',
              completed: true,
              reviewArtifactRef: 'log:security-review',
            },
          ];
        },
      },
      humanApprovals: {
        async findLatest() {
          return {
            actor: 'alice',
            headSha: testedHeadSha,
            approvedAt: new Date().toISOString(),
          };
        },
      },
      risk: {
        async find() {
          return {
            runId: RUN_ID,
            headSha: testedHeadSha,
            severity: 'low' as const,
            requiresHumanReview: false,
          };
        },
      },
      findings: fx.findingRepo,
    });
    const aggregator = new GateAggregator(passingReader);
    const evaluator = new MergeFinalEvaluator({
      hydrator: fx.hydrator,
      aggregator,
      store: fx.artifacts,
    });

    const evaluated = await evaluator.evaluate({
      runId: RUN_ID,
      repo: REPO,
      prNumber: pr.prNumber,
      testedHeadSha,
      testedBaseSha: baseSha40,
      requiresHumanReview: false,
    });

    expect(evaluated.decision.decision).toBe('refuse');
    expect(evaluated.decision.reasons.join('\n')).toMatch(/head_sha drift|reviewed_head_sha drift/);

    // And the merge service must also refuse on this decision.
    const liveProtection: BranchProtectionSnapshot = {
      requiredCheckCount: 3,
      requiredReviewCount: 1,
      requiresStrictStatusChecks: true,
      enforceAdmins: true,
      dismissesStaleReviews: true,
    };
    const mergeResult = await fx.mergeService.merge({
      runId: RUN_ID,
      repo: REPO,
      prNumber: pr.prNumber,
      decision: evaluated.decision,
      protection: liveProtection,
      requiresHumanReview: false,
      humanReviewPassed: true,
    });
    expect(mergeResult.merged).toBe(false);
    expect(mergeResult.reasons.length).toBeGreaterThan(0);

    // Audit chain must still verify cleanly — refusing produces an
    // audit record, not a broken chain.
    const verify = await fx.checkpointVerifier.verify(RUN_ID);
    expect(verify.ok).toBe(true);

    // And NO pr.merge mutation was recorded on GitHub.
    expect(fx.fakeGitHub.recordedKinds()).not.toContain('pr.merge');
  });
});

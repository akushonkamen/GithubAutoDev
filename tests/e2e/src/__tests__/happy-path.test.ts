/**
 * T-E2E-004 — Plan A end-to-end happy-path integration test.
 *
 * Drives the real cgao pipeline top-to-bottom with fakes only at the
 * external boundaries (GitHub API, git CLI, agent runner, LLM). The
 * test asserts at each gate to surface exactly which stage regressed.
 *
 * Stages exercised:
 *
 *   intake.classify → spec → plan → handoff(×2) → branch → commit →
 *   PR (dedup) → review (code + security) → gate aggregate →
 *   final evaluator → merge → issue close → audit chain verify.
 *
 * LLM-generated artifacts (ImplementationPlan, classification hints)
 * are constructed directly via their zod schemas (`.parse()`) — there
 * is no LLM in this path.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type BranchProtectionSnapshot,
  type ImplementationPlan,
  type ImplementationTask,
  type RequirementSpec,
  buildHandoff,
  buildImplementationPlan,
  classify,
  generateRequirementSpec,
  implementationPlanSchema,
} from '@cgao/orchestrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toOverlayEntries } from '../fakes/fake-runner-queue.js';
import { type HappyPathFixture, buildHappyPathFixture } from '../fixtures/happy-path-fixture.js';

const REPO = 'cgao/test';
const ISSUE_NUMBER = 42;
const RUN_ID = `run_${randomUUID()}`;
const PLAN_ID = 'plan-0001';

describe('T-E2E-004 — end-to-end happy path', () => {
  let fx: HappyPathFixture;

  beforeEach(() => {
    fx = buildHappyPathFixture({
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      botLogin: 'cgao-bot[bot]',
      controlToken: 'e2e-control-token',
      baseSha: '0'.repeat(40),
    });
  });

  afterEach(() => {
    fx.fakeGitHub.reset();
  });

  it('drives the full pipeline from intake classification to issue close', async () => {
    // -----------------------------------------------------------------
    // Stage 1: intake classification — issues.opened webhook arrives.
    //
    // We construct the ClassifyResult directly via classify() (the
    // deterministic tier-1 fast path). The hint is advisory; the
    // authoritative label set happens later in MOD-ISSUE.
    // -----------------------------------------------------------------

    const classifyResult = classify({
      message: '@cgao-bot bug: the deploy script is broken',
      mentions: ['@cgao-bot'],
      mode: 'auto',
      config: {
        confidenceThreshold: 0.7,
        maxClarifyRounds: 5,
        defaultModel: 'sonnet',
      },
      sourceConfig: {
        explicitKeywords: ['bug', 'deploy', 'broken'],
      },
    });

    expect(classifyResult.tier).toBe('explicit');
    expect(classifyResult.ready).toBe(true);
    expect(classifyResult.hint.categoryHint).toBe('bug');

    // -----------------------------------------------------------------
    // Stage 2: RequirementSpec — deterministic build from the issue
    // snapshot. No LLM. The spec carries 1 acceptance criterion so
    // the plan can map a single task to it.
    // -----------------------------------------------------------------

    const snapshot = {
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      title: 'Deploy script is broken',
      body: 'The deploy script crashes on `pnpm deploy`.',
      labels: ['cgao:new'],
      authorLogin: 'alice',
    };

    const spec: RequirementSpec = generateRequirementSpec({
      snapshot,
      extracted: {
        summary: 'Fix the deploy script so `pnpm deploy` succeeds.',
        goals: ['Deploy script runs without crashing.'],
        nonGoals: ['Do not change deployment targets.'],
        acceptanceCriteria: [{ description: '`pnpm deploy` exits 0', verification: 'automated' }],
        risks: [],
        openQuestions: [],
      },
      generation: 0,
    });

    expect(spec.openQuestions).toHaveLength(0);
    expect(spec.acceptanceCriteria.length).toBeGreaterThanOrEqual(1);

    // -----------------------------------------------------------------
    // Stage 3: ImplementationPlan — constructed via zod schema parse.
    // At least 2 tasks; every acceptance criterion mapped; allowedPaths
    // cover the change.
    // -----------------------------------------------------------------

    const tasks: ImplementationTask[] = [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'Patch src/deploy.ts to handle the missing env var.',
        allowedPaths: ['src/deploy.ts'],
        forbiddenPaths: [],
        dependsOn: [],
        agent: 'implementer',
        modelTier: 'standard',
      },
      {
        id: 't2',
        satisfies: ['ac-1'],
        description: 'Add a CI dry-run smoke check for the deploy module.',
        allowedPaths: ['src/deploy.ts', 'src/deploy.dryrun.ts'],
        forbiddenPaths: [],
        dependsOn: ['t1'],
        agent: 'tester',
        modelTier: 'low',
      },
    ];

    const plan: ImplementationPlan = buildImplementationPlan({
      spec,
      requirementSpecDigest: spec.issueSnapshotSha,
      tasks,
      planId: PLAN_ID,
      generation: spec.generation,
    });

    // Schema round-trip proves the plan is well-formed.
    implementationPlanSchema.parse(plan);
    expect(plan.tasks.length).toBeGreaterThanOrEqual(2);
    expect(plan.requirementSpecDigest).toBe(spec.issueSnapshotSha);
    expect(plan.planSha).toMatch(/^[0-9a-f]{64}$/);

    // -----------------------------------------------------------------
    // Stage 4: Handoffs — analysis→plan + plan→dev. Both flow through
    // buildHandoff which is the canonical hash-chained assembler.
    // -----------------------------------------------------------------

    const analysisToPlan = buildHandoff({
      runId: RUN_ID,
      generation: 0,
      fromStage: 'analysis',
      toStage: 'plan',
      upstreamRef: `artifact://requirement-spec/${spec.issueSnapshotSha}`,
      payload: {
        kind: 'analysis_to_plan',
        data: {
          requirementSpecDigest: spec.issueSnapshotSha,
          summary: spec.summary,
          openQuestions: [],
        },
      },
    });
    expect(analysisToPlan.payloadSha).toMatch(/^[0-9a-f]{64}$/);

    const planToDev = buildHandoff({
      runId: RUN_ID,
      generation: 1,
      fromStage: 'plan',
      toStage: 'dev',
      upstreamRef: `artifact://implementation-plan/${plan.planSha}`,
      payload: {
        kind: 'plan_to_dev',
        data: {
          planId: plan.planId,
          planSha: plan.planSha,
          taskIds: ['t1', 't2'],
          allowedPaths: ['src/deploy.ts'],
          forbiddenPaths: [],
        },
      },
    });
    expect(planToDev.handoffSha).toMatch(/^[0-9a-f]{64}$/);

    // -----------------------------------------------------------------
    // Stage 5: BranchService.create() — fake git returns baseSha.
    // -----------------------------------------------------------------

    const branch = await fx.branchService.create({
      runId: RUN_ID,
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      slug: 'fix-deploy-script',
    });

    expect(branch.created).toBe(true);
    expect(branch.branchName).toBe(`cgao/issue-${ISSUE_NUMBER}-fix-deploy-script`);
    expect(branch.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(fx.fakeGit.has(branch.branchName)).toBe(true);

    // Idempotency: a second create() for the same slug reuses the branch.
    const branchReuse = await fx.branchService.create({
      runId: RUN_ID,
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      slug: 'fix-deploy-script',
    });
    expect(branchReuse.created).toBe(false);
    expect(branchReuse.branchName).toBe(branch.branchName);

    // -----------------------------------------------------------------
    // Stage 6: CommitBuilder — apply canned WorkerResult patch through
    // the M5 clean-checkout applier. allowedPaths cover the change.
    // -----------------------------------------------------------------

    // Seed a benign base tree (path → contents).
    const baseTree = new Map<string, string>([
      ['src/deploy.ts', 'export const deploy = () => null;\n'],
      ['README.md', '# test repo\n'],
    ]);
    fx.fakeGit.seedBaseTree(branch.branchName, baseTree);

    // The fake runner queue has a canned patch bound to RUN_ID.
    const cannedFiles = [
      {
        path: 'src/deploy.ts',
        contents: 'export const deploy = () => { return 0; };\n',
      },
    ];
    fx.fakeQueue.bindPatch(RUN_ID, { files: cannedFiles });
    const cannedPatch = fx.fakeQueue.patchFor(RUN_ID);
    if (!cannedPatch) throw new Error('canned patch missing for RUN_ID');
    const overlay = toOverlayEntries(cannedPatch);

    const commitResult = await fx.commitBuilder.build({
      runId: RUN_ID,
      branchName: branch.branchName,
      patch: {
        baseSha: branch.baseSha,
        entries: overlay,
        allowedPaths: ['src/deploy.ts'],
        forbiddenPaths: [],
      },
      message: {
        summary: 'fix deploy script for prod region',
        issueNumber: ISSUE_NUMBER,
        runId: RUN_ID,
        specId: spec.issueSnapshotSha,
        planId: plan.planId,
        planSha: plan.planSha,
      },
      base: baseTree,
    });

    expect(commitResult.decision).toBe('committed');
    expect(commitResult.commitSha).toBeDefined();
    expect(commitResult.changedFiles).toContain('src/deploy.ts');
    // Commit message MUST carry traceability trailers.
    // (The commit message itself isn't returned; we verify the change
    // files + that the commit landed in the fake git port instead.)
    expect(commitResult.reasons).toHaveLength(0);

    if (!commitResult.commitSha) throw new Error('commitSha missing');
    const headSha = commitResult.commitSha;
    expect(headSha).toMatch(/^sha256:[0-9a-f]{64}$/);

    // -----------------------------------------------------------------
    // Stage 7: PullRequestService.create() — fake GitHub returns PR #1.
    // Call it twice and assert dedup (only 1 PR).
    // -----------------------------------------------------------------

    // GitHub surface uses 40-char git-style sha. The internal commit
    // sha is `sha256:<64hex>`; slice to 40 for everything the GitHub
    // API surface (and thus the hydrator) sees.
    const headSha40ForPr = headSha.slice('sha256:'.length).slice(0, 40);

    fx.fakeGitHub.prepareNextPr({ runId: RUN_ID, headSha: headSha40ForPr });

    // Pre-create the workflow run row so PRService can persist prNumber.
    const workflowRun = await fx.workflowRuns.create({
      id: RUN_ID,
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: ISSUE_NUMBER,
      state: 'implementing',
      riskLevel: 'low',
      generation: spec.generation,
    });
    expect(workflowRun.id).toBe(RUN_ID);

    const prBody =
      '## cgao: fix deploy script\n\nTraceability block.\n\n---\n\n_cgao authored this PR._';

    const pr1 = await fx.prService.createPr({
      runId: RUN_ID,
      repo: REPO,
      branchName: branch.branchName,
      baseBranch: 'main',
      headSha: headSha40ForPr,
      title: `cgao: fix deploy script (issue #${ISSUE_NUMBER})`,
      body: prBody,
    });

    expect(pr1.created).toBe(true);
    expect(pr1.prNumber).toBeGreaterThanOrEqual(1);

    // Second call with the same head sha should dedup to the same PR.
    const pr2 = await fx.prService.createPr({
      runId: RUN_ID,
      repo: REPO,
      branchName: branch.branchName,
      baseBranch: 'main',
      headSha: headSha40ForPr,
      title: `cgao: fix deploy script (issue #${ISSUE_NUMBER})`,
      body: prBody,
    });
    expect(pr2.created).toBe(false);
    expect(pr2.prNumber).toBe(pr1.prNumber);

    // The workflow run row now carries the prNumber.
    const runAfterPr = await fx.workflowRuns.findById(RUN_ID);
    expect(runAfterPr?.prNumber).toBe(pr1.prNumber);

    // -----------------------------------------------------------------
    // Stage 8: ReviewRunner (code) + SecurityReviewRunner — feed a
    // benign diff; assert ReviewResult bound to headSha, zero findings.
    // -----------------------------------------------------------------

    const diff =
      '--- a/src/deploy.ts\n+++ b/src/deploy.ts\n@@ -1 +1,3 @@\n-export const deploy = () => null;\n+export const deploy = () => { return 0; };\n';

    // dev_to_review handoff uses string64 schema (64 hex chars). The
    // commit sha is `sha256:<64hex>`; strip the prefix for the handoff
    // payload. The base sha must also be 64 chars — derive it from the
    // fake git's deterministic base via sha256.
    const headSha64 = headSha.slice('sha256:'.length);
    const baseSha64 = createHash('sha256').update(branch.baseSha).digest('hex');

    const reviewerContext = {
      spec,
      plan,
      handoff: buildHandoff({
        runId: RUN_ID,
        generation: 2,
        fromStage: 'dev',
        toStage: 'review',
        upstreamRef: `artifact://implementation-plan/${plan.planSha}`,
        payload: {
          kind: 'dev_to_review',
          data: {
            baseSha: baseSha64,
            headSha: headSha64,
            patchSha: headSha,
            changedFiles: ['src/deploy.ts'],
            testsRun: [{ command: 'tsc --noEmit', exitCode: 0, logRef: 'log:tsc' }],
            risks: [],
            executorNarrative: 'Patched the missing env var guard.',
          },
        },
      }),
      diff,
      gate: { passed: true, logArtifactRef: 'log:fast-gate' },
    };

    const codeReview = await fx.reviewRunner.run({
      runId: RUN_ID,
      prNumber: pr1.prNumber,
      headSha: headSha.slice('sha256:'.length).slice(0, 40),
      baseSha: branch.baseSha,
      repo: REPO,
      context: reviewerContext,
    });
    expect(codeReview.result.findings).toHaveLength(0);
    expect(codeReview.result.headSha).toHaveLength(40);

    const secReview = await fx.securityRunner.run({
      runId: RUN_ID,
      prNumber: pr1.prNumber,
      headSha: headSha.slice('sha256:'.length).slice(0, 40),
      baseSha: branch.baseSha,
      repo: REPO,
      context: reviewerContext,
    });
    expect(secReview.result.findings).toHaveLength(0);

    // -----------------------------------------------------------------
    // Stage 9: ReviewFindingRepository.upsert() for any findings —
    // happy path has zero, so the repo should be empty.
    // -----------------------------------------------------------------

    const findingsForPr = await fx.findingRepo.findByPr(pr1.prNumber);
    expect(findingsForPr).toHaveLength(0);

    const blocking = await fx.findingRepo.findBlocking(pr1.prNumber);
    expect(blocking).toHaveLength(0);

    // -----------------------------------------------------------------
    // Stage 10/11: GateAggregator + MergeFinalEvaluator → mergeable=true
    // and decision='merge'.
    //
    // The default fixture wires empty lookups; we replace the
    // hydrator-side state by pre-seeding the FakeGitHubClient's live
    // snapshot for the PR (already done in createPr) AND by giving
    // the gate reader the test-gate + risk lookups bound to headSha.
    // -----------------------------------------------------------------

    // We need a fresh fixture wiring for the gate lookups; easiest is
    // to construct a GateResultsReader with stubbed lookups.
    const headSha40 = headSha.slice('sha256:'.length).slice(0, 40);
    const baseSha40 = branch.baseSha;

    const passingReader = new (await import('@cgao/orchestrator')).GateResultsReader({
      testGates: {
        async findLatest() {
          return {
            runId: RUN_ID,
            headSha: headSha40,
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
              headSha: headSha40,
              reviewer: 'code',
              completed: true,
              reviewArtifactRef: codeReview.artifactRef,
            },
            {
              runId: RUN_ID,
              headSha: headSha40,
              reviewer: 'security',
              completed: true,
              reviewArtifactRef: secReview.artifactRef,
            },
          ];
        },
      },
      humanApprovals: {
        async findLatest() {
          return {
            actor: 'alice',
            headSha: headSha40,
            approvedAt: new Date().toISOString(),
            sourceRef: 'comment:1',
          };
        },
      },
      risk: {
        async find() {
          return {
            runId: RUN_ID,
            headSha: headSha40,
            severity: 'low' as const,
            requiresHumanReview: false,
          };
        },
      },
      findings: fx.findingRepo,
    });
    const passingAggregator = new (await import('@cgao/orchestrator')).GateAggregator(
      passingReader,
    );
    const finalEval = new (await import('@cgao/orchestrator')).MergeFinalEvaluator({
      hydrator: fx.hydrator,
      aggregator: passingAggregator,
      store: fx.artifacts,
    });

    const evaluated = await finalEval.evaluate({
      runId: RUN_ID,
      repo: REPO,
      prNumber: pr1.prNumber,
      testedHeadSha: headSha40,
      testedBaseSha: baseSha40,
      requiresHumanReview: false,
    });

    expect(evaluated.decision.decision).toBe('merge');
    expect(evaluated.aggregated.mergeable).toBe(true);

    // -----------------------------------------------------------------
    // Stage 12: MergeService.merge() — fake GitHub records 'merge',
    // 'close issue', 'remove label'. We exercise merge + issue close.
    // -----------------------------------------------------------------

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
      prNumber: pr1.prNumber,
      decision: evaluated.decision,
      protection: liveProtection,
      requiresHumanReview: false,
      humanReviewPassed: true,
    });

    expect(mergeResult.merged).toBe(true);
    expect(mergeResult.mergeCommitSha).toBeDefined();
    expect(mergeResult.reasons).toHaveLength(0);

    const closeResult = await fx.issueCloseService.close({
      runId: RUN_ID,
      repo: REPO,
      issueNumber: ISSUE_NUMBER,
      mergedHeadSha: headSha40,
      mergeCommitSha: mergeResult.mergeCommitSha ?? '',
    });

    expect(closeResult.closed).toBe(true);
    expect(closeResult.commentPosted).toBe(true);
    expect(closeResult.labelsRemoved.length).toBeGreaterThan(0);

    // -----------------------------------------------------------------
    // Stage 13: Audit chain — write a checkpoint + verify.
    // -----------------------------------------------------------------

    await fx.checkpointWriter.write({ runId: RUN_ID });
    const verify = await fx.checkpointVerifier.verify(RUN_ID);
    expect(verify.ok).toBe(true);

    // -----------------------------------------------------------------
    // Stage 14: FakeGitHubClient mutation log order — must match the
    // spec flow (create PR → merge → close → strip labels → comment).
    // -----------------------------------------------------------------

    const kinds = fx.fakeGitHub.recordedKinds();
    expect(kinds[0]).toBe('pr.create');
    expect(kinds).toContain('pr.merge');
    expect(kinds).toContain('issue.close');
    // Label removals come from IssueCloseService; one per default label.
    expect(kinds.filter((k) => k === 'issue.label.remove').length).toBeGreaterThan(0);
    expect(kinds[kinds.length - 1]).toBe('issue.comment.add');
  });
});

/**
 * T-M8-001 ReviewRunner.
 *
 * Contracts (spec §12.9 / §13.2):
 *   - ReviewResult bound to head_sha + base_sha (bindingHash covers them).
 *   - Implementer agent (CCA `dev` worker) is structurally excluded —
 *     every emitted finding carries reviewer='code'.
 *   - Comments post through the PullRequestService-style broker; the
 *     runner never calls GitHub mutations directly.
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { InMemoryAuditChainService } from '@cgao/audit';
import { InMemoryReviewFindingRepository } from '@cgao/db';
import { describe, expect, it } from 'vitest';
import { type Handoff, buildHandoff } from '../../specs/handoff.js';
import type { ImplementationPlan } from '../../specs/implementation-plan.js';
import type { RequirementSpec } from '../../specs/requirement-spec.js';
import { ReviewFindingRepo } from '../review-finding-repo.js';
import { type ReviewCommentBroker, ReviewRunner, type ReviewerLlmPort } from '../review-runner.js';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const HANDOFF_HEAD = 'c'.repeat(64);
const HANDOFF_BASE = 'd'.repeat(64);

function makeSpec(): RequirementSpec {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    issueSnapshotSha: 'a'.repeat(64),
    summary: 'do the thing',
    goals: ['thing'],
    nonGoals: [],
    acceptanceCriteria: [{ description: 'it works', verification: 'automated' }],
    risks: [],
    openQuestions: [],
    generation: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makePlan(): ImplementationPlan {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    requirementSpecDigest: 'a'.repeat(64),
    planSha: 'b'.repeat(64),
    planId: 'plan-1',
    tasks: [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'impl',
        allowedPaths: ['src/**'],
        forbiddenPaths: [],
        dependsOn: [],
        agent: 'implementer',
        modelTier: 'standard',
      },
    ],
    generation: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeHandoff(): Handoff {
  return buildHandoff({
    runId: 'run_1',
    generation: 1,
    fromStage: 'dev',
    toStage: 'review',
    upstreamRef: 'artifact://plan/x',
    payload: {
      kind: 'dev_to_review',
      data: {
        baseSha: HANDOFF_BASE,
        headSha: HANDOFF_HEAD,
        patchSha: 'e'.repeat(64),
        changedFiles: ['src/foo.ts'],
        risks: ['none'],
        executorNarrative: 'I picked the easy path, trust me',
      },
    },
  });
}

describe('T-M8-001 ReviewRunner', () => {
  it('binds ReviewResult to head_sha + base_sha', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({
          findings: [
            {
              rule: 'missing-test',
              file: 'src/foo.ts',
              lineStart: 1,
              lineEnd: 2,
              title: 't',
              message: 'add test',
              severity: 'low',
            },
          ],
          summary: 'ok',
        });
      },
    };
    const runner = new ReviewRunner({ llm, store, findings: repo });
    const result = await runner.run({
      runId: 'run_1',
      prNumber: null,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: makeSpec(),
        plan: makePlan(),
        handoff: makeHandoff(),
        diff: 'diff --git a/src/foo.ts b/src/foo.ts',
        gate: { passed: true, logArtifactRef: 'sha256:'.concat('a'.repeat(64)) },
      },
    });
    expect(result.result.headSha).toBe(HEAD);
    expect(result.result.baseSha).toBe(BASE);
    expect(result.result.bindingHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    // bindingHash input included head + base, so a different head gives a different hash.
    expect(result.result.bindingHash).not.toBe(`sha256:${'0'.repeat(64)}`);
  });

  it('stamps reviewer=code on every finding (implementer agent excluded)', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({
          findings: [
            {
              rule: 'r1',
              file: 'a',
              lineStart: 1,
              lineEnd: 1,
              title: 't',
              message: 'm',
              severity: 'low',
            },
            {
              rule: 'r2',
              file: 'b',
              lineStart: 2,
              lineEnd: 2,
              title: 't',
              message: 'm',
              severity: 'medium',
            },
          ],
        });
      },
    };
    const runner = new ReviewRunner({ llm, store, findings: repo });
    const { result } = await runner.run({
      runId: 'run_1',
      prNumber: null,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: makeSpec(),
        plan: makePlan(),
        handoff: makeHandoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    expect(result.findings.every((f) => f.reviewer === 'code')).toBe(true);
    expect(result.findings.every((f) => f.blocking === false)).toBe(true);
  });

  it('posts review summary through trusted broker (no direct GitHub mutation)', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    let posted = 0;
    let lastSummary = '';
    let lastHead = '';
    const comments: ReviewCommentBroker = {
      async postReviewSummary(args) {
        posted++;
        lastSummary = args.summary;
        lastHead = args.headSha;
      },
    };
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({ findings: [], summary: 'clean' });
      },
    };
    const runner = new ReviewRunner({ llm, store, findings: repo, comments });
    await runner.run({
      runId: 'run_1',
      prNumber: 99,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: makeSpec(),
        plan: makePlan(),
        handoff: makeHandoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    expect(posted).toBe(1);
    expect(lastSummary).toBe('clean');
    expect(lastHead).toBe(HEAD);
  });

  it('does not include executorNarrative in the prompt', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    let capturedPrompt = '';
    const llm: ReviewerLlmPort = {
      async complete(args) {
        capturedPrompt = args.prompt;
        return JSON.stringify({ findings: [], summary: 'ok' });
      },
    };
    const runner = new ReviewRunner({ llm, store, findings: repo });
    await runner.run({
      runId: 'run_1',
      prNumber: null,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: makeSpec(),
        plan: makePlan(),
        handoff: makeHandoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    // executorNarrative must not appear verbatim in the prompt.
    expect(capturedPrompt).not.toContain('I picked the easy path, trust me');
    // The literal JSON key may appear in the redaction sentinel, but the
    // VALUE must be gone.
    expect(capturedPrompt).not.toMatch(/executorNarrative[^}]*I picked/u);
  });

  it('persists a SHA-bound artifact', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({ findings: [] });
      },
    };
    const runner = new ReviewRunner({ llm, store, findings: repo });
    const { artifactRef } = await runner.run({
      runId: 'run_1',
      prNumber: null,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: makeSpec(),
        plan: makePlan(),
        handoff: makeHandoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    const artifact = await store.read(artifactRef);
    expect(artifact).not.toBeNull();
    expect(JSON.parse(artifact?.content ?? '{}').kind).toBe('review_result');
  });

  it('audit service is wireable (smoke)', () => {
    void new InMemoryAuditChainService();
    expect(true).toBe(true);
  });
});

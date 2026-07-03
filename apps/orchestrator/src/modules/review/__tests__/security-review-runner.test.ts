/**
 * T-M8-002 SecurityReviewRunner.
 *
 * Contracts (spec §12.9):
 *   - Diff touching src/auth/** triggers security review.
 *   - SecurityFinding can be marked blocking=true → blocks merge in M9.
 *   - Severity floor enforced (LLM cannot downgrade critical → low).
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { InMemoryReviewFindingRepository } from '@cgao/db';
import { describe, expect, it } from 'vitest';
import { buildHandoff } from '../../specs/handoff.js';
import type { ImplementationPlan } from '../../specs/implementation-plan.js';
import type { RequirementSpec } from '../../specs/requirement-spec.js';
import { ReviewFindingRepo } from '../review-finding-repo.js';
import { enforceSeverityFloor } from '../security-finding.js';
import { SECURITY_TRIGGER_GLOBS, shouldTriggerSecurityReview } from '../security-review-prompt.js';
import { type ReviewerLlmPort, SecurityReviewRunner } from '../security-review-runner.js';

const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);
const HANDOFF_HEAD = 'c'.repeat(64);
const HANDOFF_BASE = 'd'.repeat(64);

function spec(): RequirementSpec {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    issueSnapshotSha: 'a'.repeat(64),
    summary: 's',
    goals: ['g'],
    nonGoals: [],
    acceptanceCriteria: [{ description: 'd', verification: 'automated' }],
    risks: [],
    openQuestions: [],
    generation: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}
function plan(): ImplementationPlan {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    requirementSpecDigest: 'a'.repeat(64),
    planSha: 'b'.repeat(64),
    planId: 'p1',
    tasks: [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'd',
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
function handoff(): ReturnType<typeof buildHandoff> {
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
        changedFiles: ['src/auth/login.ts'],
      },
    },
  });
}

describe('T-M8-002 shouldTriggerSecurityReview', () => {
  it('triggers when src/auth/** is touched', () => {
    expect(shouldTriggerSecurityReview(['src/auth/login.ts', 'README.md'])).toBe(true);
  });
  it('triggers for payment / secret / input-validation', () => {
    expect(shouldTriggerSecurityReview(['src/payment/charge.ts'])).toBe(true);
    expect(shouldTriggerSecurityReview(['src/secret/keys.ts'])).toBe(true);
    expect(shouldTriggerSecurityReview(['src/input-validation/sanitize.ts'])).toBe(true);
  });
  it('does not trigger for unrelated paths', () => {
    expect(shouldTriggerSecurityReview(['README.md', 'docs/foo.md'])).toBe(false);
  });
  it('globs include the auth prefix', () => {
    expect(SECURITY_TRIGGER_GLOBS.some((g) => g.startsWith('src/auth/'))).toBe(true);
  });
});

describe('T-M8-002 enforceSeverityFloor', () => {
  it('clamps a critical rule reported as low up to critical', () => {
    expect(enforceSeverityFloor('sql-injection', 'low')).toBe('critical');
  });
  it('does not downgrade a high-severity report below the floor', () => {
    expect(enforceSeverityFloor('secret-in-source', 'low')).toBe('high');
  });
  it('leaves a reported severity above the floor unchanged', () => {
    expect(enforceSeverityFloor('sql-injection', 'critical')).toBe('critical');
  });
});

describe('T-M8-002 SecurityReviewRunner', () => {
  it('stamps reviewer=security and persists blocking findings', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({
          findings: [
            {
              rule: 'sql-injection',
              file: 'src/auth/login.ts',
              lineStart: 5,
              lineEnd: 5,
              title: 'sqli',
              message: 'unsafe concat',
              severity: 'low',
              blocking: true,
            },
          ],
          summary: 'critical sqli',
        });
      },
    };
    const runner = new SecurityReviewRunner({ llm, store, findings: repo });
    const { result } = await runner.run({
      runId: 'run_1',
      prNumber: 7,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: spec(),
        plan: plan(),
        handoff: handoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.reviewer).toBe('security');
    expect(result.findings[0]?.blocking).toBe(true);
    // Floor enforced: low → critical.
    expect(result.findings[0]?.severity).toBe('critical');
    // blocking finding is queryable.
    const blocking = await repo.findBlocking(7);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.severity).toBe('critical');
  });

  it('LLM cannot downgrade critical rule to low (severity floor)', async () => {
    const store = new InMemoryArtifactStore();
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const llm: ReviewerLlmPort = {
      async complete() {
        return JSON.stringify({
          findings: [
            // LLM tries to call it 'low' but the rule is on the critical floor.
            {
              rule: 'auth-bypass',
              file: 'src/auth/login.ts',
              lineStart: 1,
              lineEnd: 2,
              title: 'bypass',
              message: 'm',
              severity: 'low',
              blocking: false,
            },
          ],
          summary: '',
        });
      },
    };
    const runner = new SecurityReviewRunner({ llm, store, findings: repo });
    const { result } = await runner.run({
      runId: 'run_1',
      prNumber: 1,
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      context: {
        spec: spec(),
        plan: plan(),
        handoff: handoff(),
        diff: 'diff',
        gate: { passed: true, logArtifactRef: 'sha256:x' },
      },
    });
    expect(result.findings[0]?.severity).toBe('critical');
  });
});

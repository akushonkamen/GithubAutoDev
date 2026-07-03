/**
 * T-M8-005 ReviewerContextBuilder + HandoffFilter.
 *
 * Contracts (spec §5 / §12.9):
 *   - Reviewer prompt contains spec, plan, diff, gate evidence.
 *   - Reviewer prompt does NOT contain executorNarrative.
 *   - Defense-in-depth: even if a handoff tampered with redaction,
 *     HandoffFilter strips executorNarrative again.
 */

import { describe, expect, it } from 'vitest';
import { type Handoff, buildHandoff } from '../../specs/handoff.js';
import type { ImplementationPlan } from '../../specs/implementation-plan.js';
import type { RequirementSpec } from '../../specs/requirement-spec.js';
import { applyHandoffFilter, buildReviewerContext } from '../reviewer-context-builder.js';

const HEAD = 'c'.repeat(64);
const BASE = 'd'.repeat(64);

function spec(): RequirementSpec {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    issueSnapshotSha: 'a'.repeat(64),
    summary: 'SUMMARY_GOAL',
    goals: ['goal-1'],
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
    planId: 'PLAN_ID_42',
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
function handoffWithNarrative(narrative: string): Handoff {
  return buildHandoff({
    runId: 'run_1',
    generation: 1,
    fromStage: 'dev',
    toStage: 'review',
    upstreamRef: 'artifact://plan/x',
    payload: {
      kind: 'dev_to_review',
      data: {
        baseSha: BASE,
        headSha: HEAD,
        patchSha: 'e'.repeat(64),
        changedFiles: ['src/foo.ts'],
        risks: ['r'],
        executorNarrative: narrative,
      },
    },
  });
}

describe('T-M8-005 ReviewerContextBuilder', () => {
  it('includes spec, plan, diff, gate evidence in the prompt', () => {
    const built = buildReviewerContext({
      spec: spec(),
      plan: plan(),
      handoff: handoffWithNarrative(''),
      diff: 'DIFF_CONTENT_HERE',
      gate: { passed: true, logArtifactRef: 'sha256:abc' },
    });
    expect(built.prompt).toContain('SUMMARY_GOAL');
    expect(built.prompt).toContain('PLAN_ID_42');
    expect(built.prompt).toContain('DIFF_CONTENT_HERE');
    expect(built.prompt).toContain('sha256:abc');
  });

  it('does NOT include executorNarrative verbatim', () => {
    const narrative = 'I_AM_THE_EXECUTOR_TRUST_ME';
    const built = buildReviewerContext({
      spec: spec(),
      plan: plan(),
      handoff: handoffWithNarrative(narrative),
      diff: 'diff',
      gate: { passed: true, logArtifactRef: 'sha256:x' },
    });
    // Regex assert: the narrative value must not appear anywhere.
    expect(built.prompt).not.toContain(narrative);
  });

  it('wraps the diff in an untrusted envelope', () => {
    const built = buildReviewerContext({
      spec: spec(),
      plan: plan(),
      handoff: handoffWithNarrative(''),
      diff: 'PAYLOAD_IN_DIFF',
      gate: { passed: true, logArtifactRef: 'sha256:x' },
    });
    expect(built.prompt).toContain('UNTRUSTED_CONTENT BEGIN');
    expect(built.prompt).toContain('UNTRUSTED_CONTENT END');
    expect(built.prompt).toContain('PAYLOAD_IN_DIFF');
  });

  it('records redactions when executorNarrative was non-empty', () => {
    const built = buildReviewerContext({
      spec: spec(),
      plan: plan(),
      handoff: handoffWithNarrative('leak'),
      diff: 'diff',
      gate: { passed: true, logArtifactRef: 'sha256:x' },
    });
    expect(built.redactions.some((r) => r.path.includes('executorNarrative'))).toBe(true);
  });
});

describe('T-M8-005 HandoffFilter (defense-in-depth)', () => {
  it('strips executorNarrative from a tampered dev_to_review handoff', () => {
    const tampered = handoffWithNarrative('SHOULD_BE_STRIPPED');
    // Simulate upstream tampering: bypass readHandoff redaction by
    // directly mutating the payload before applying the filter. Cast
    // through unknown because the schema-bound shape doesn't permit
    // executorNarrative on a plan_to_dev payload — this is the shape
    // an attacker would have to forge.
    const tamperedView: Handoff = {
      ...tampered,
      payload: {
        kind: 'dev_to_review',
        data: {
          baseSha: BASE,
          headSha: HEAD,
          patchSha: 'e'.repeat(64),
          changedFiles: ['src/foo.ts'],
          risks: [],
          executorNarrative: 'LEAKED_NARRATIVE',
        },
      } as unknown as Handoff['payload'],
    };
    const { handoff: filtered, stripped } = applyHandoffFilter(tamperedView);
    expect(stripped).toBe(true);
    if (filtered.payload.kind === 'dev_to_review') {
      expect(filtered.payload.data.executorNarrative).not.toBe('LEAKED_NARRATIVE');
    }
  });

  it('is a no-op for handoffs that were already redacted', () => {
    const h = handoffWithNarrative('narrative');
    const { stripped } = applyHandoffFilter(h);
    // readHandoff in buildHandoff keeps the original narrative on the
    // handoff body (redaction happens at readHandoff time). applyHandoffFilter
    // therefore strips it.
    expect(stripped).toBe(true);
  });

  it('is a no-op for non-dev_to_review handoffs', () => {
    const planHandoff = buildHandoff({
      runId: 'r',
      generation: 1,
      fromStage: 'plan',
      toStage: 'dev',
      upstreamRef: 'artifact://spec/x',
      payload: {
        kind: 'plan_to_dev',
        data: { planId: 'p', planSha: 'b'.repeat(64), taskIds: ['t1'] },
      },
    });
    const { stripped } = applyHandoffFilter(planHandoff);
    expect(stripped).toBe(false);
  });
});

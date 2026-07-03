/**
 * Handoff artifact schema — T-M4-006, spec §5, §11, §12.6.
 *
 * Locks the contracts:
 *   - Three handoff kinds: analysis_to_plan, plan_to_dev, dev_to_review.
 *   - Reviewer does NOT see payload.data.executorNarrative by default.
 *   - payloadSha + handoffSha are deterministic sha256 over canonical JSON.
 *   - verifyHandoffPayloadSha detects tampering.
 */

import { describe, expect, it } from 'vitest';
import {
  type Handoff,
  buildHandoff,
  handoffSchema,
  readHandoff,
  verifyHandoffPayloadSha,
} from '../handoff.js';

const sha64 = (s: string) => s.padEnd(64, '0').slice(0, 64);

function planToDevData(h: Handoff) {
  if (h.payload.kind !== 'plan_to_dev')
    throw new Error(`expected plan_to_dev, got ${h.payload.kind}`);
  return h.payload.data;
}

function devToReviewData(h: Handoff) {
  if (h.payload.kind !== 'dev_to_review')
    throw new Error(`expected dev_to_review, got ${h.payload.kind}`);
  return h.payload.data;
}

describe('buildHandoff — analysis→plan (T-M4-006, spec §12.4)', () => {
  it('produces a valid handoff with payload_sha + handoff_sha stamped', () => {
    const h = buildHandoff({
      runId: 'wr_01',
      generation: 0,
      fromStage: 'analysis',
      toStage: 'plan',
      upstreamRef: 'artifact://requirement-spec/abc',
      payload: {
        kind: 'analysis_to_plan',
        data: {
          requirementSpecDigest: sha64('a'),
          summary: 'fix the deploy',
          openQuestions: ['which env?'],
        },
      },
      now: new Date('2026-07-03T00:00:00Z'),
    });
    expect(h.payloadSha).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.handoffSha).toMatch(/^[0-9a-f]{64}$/u);
    expect(h.kind).toBe('analysis_to_plan');
    expect(handoffSchema.parse(h)).toEqual(h);
  });
});

describe('buildHandoff — plan→dev (T-M4-006, spec §12.5)', () => {
  it('carries plan_id + plan_sha + task ids + path constraints', () => {
    const h = buildHandoff({
      runId: 'wr_01',
      generation: 1,
      fromStage: 'plan',
      toStage: 'dev',
      upstreamRef: 'artifact://plan/def',
      payload: {
        kind: 'plan_to_dev',
        data: {
          planId: 'plan-0001',
          planSha: sha64('b'),
          taskIds: ['t1', 't2'],
          allowedPaths: ['src/foo.ts'],
          forbiddenPaths: ['src/auth/'],
        },
      },
    });
    expect(planToDevData(h).taskIds).toEqual(['t1', 't2']);
    expect(h.toStage).toBe('dev');
  });
});

describe('buildHandoff — dev→review (T-M4-006, spec §12.6)', () => {
  function mkDevToReview(narrative: string): Handoff {
    return buildHandoff({
      runId: 'wr_01',
      generation: 2,
      fromStage: 'dev',
      toStage: 'review',
      upstreamRef: 'artifact://patch/xyz',
      payload: {
        kind: 'dev_to_review',
        data: {
          baseSha: sha64('base'),
          headSha: sha64('head'),
          patchSha: 'sha256:deadbeef',
          changedFiles: ['src/deploy.ts'],
          testsRun: [{ command: 'pnpm test', exitCode: 0, logRef: 'artifact://log/1' }],
          risks: ['touches deploy'],
          executorNarrative: narrative,
        },
      },
    });
  }

  it('stamps the executor narrative so an auditor can see it later', () => {
    const h = mkDevToReview('I chose option A because B was too slow.');
    expect(devToReviewData(h).executorNarrative).toContain('option A');
  });

  it('readHandoff: reviewer does NOT see executorNarrative by default', () => {
    const h = mkDevToReview('defend-my-choice');
    const result = readHandoff({ handoff: h, reader: 'reviewer' });
    expect(devToReviewData(result.handoff).executorNarrative).toBe('[redacted]');
    expect(result.redactions.length).toBe(1);
    expect(result.redactions[0]?.path).toBe('payload.data.executorNarrative');
  });

  it('readHandoff: planner/dev see the full narrative', () => {
    const h = mkDevToReview('defend-my-choice');
    expect(
      devToReviewData(readHandoff({ handoff: h, reader: 'planner' }).handoff).executorNarrative,
    ).toBe('defend-my-choice');
    expect(
      devToReviewData(readHandoff({ handoff: h, reader: 'dev' }).handoff).executorNarrative,
    ).toBe('defend-my-choice');
  });

  it('readHandoff: reviewer with allowExecutorNarrative sees the narrative', () => {
    const h = mkDevToReview('defend-my-choice');
    const result = readHandoff({
      handoff: h,
      reader: 'reviewer',
      allowExecutorNarrative: true,
    });
    expect(result.redactions).toEqual([]);
    expect(devToReviewData(result.handoff).executorNarrative).toBe('defend-my-choice');
  });

  it('readHandoff: empty narrative produces no redaction record', () => {
    const h = mkDevToReview('');
    const result = readHandoff({ handoff: h, reader: 'reviewer' });
    expect(result.redactions).toEqual([]);
  });
});

describe('verifyHandoffPayloadSha (T-M4-006, spec §5)', () => {
  it('returns true for a freshly-built handoff', () => {
    const h = buildHandoff({
      runId: 'wr_01',
      generation: 0,
      fromStage: 'analysis',
      toStage: 'plan',
      upstreamRef: 'artifact://requirement-spec/abc',
      payload: {
        kind: 'analysis_to_plan',
        data: {
          requirementSpecDigest: sha64('a'),
          summary: 'x',
        },
      },
    });
    expect(verifyHandoffPayloadSha(h)).toBe(true);
  });

  it('returns false when payload was tampered with', () => {
    const h = buildHandoff({
      runId: 'wr_01',
      generation: 0,
      fromStage: 'analysis',
      toStage: 'plan',
      upstreamRef: 'artifact://requirement-spec/abc',
      payload: {
        kind: 'analysis_to_plan',
        data: {
          requirementSpecDigest: sha64('a'),
          summary: 'original',
        },
      },
    });
    const tampered: Handoff = {
      ...h,
      payload: {
        kind: 'analysis_to_plan',
        data: {
          requirementSpecDigest: sha64('a'),
          openQuestions: [],
          summary: 'tampered',
        },
      },
    };
    expect(verifyHandoffPayloadSha(tampered)).toBe(false);
  });
});

describe('handoff payload determinism (T-M4-006)', () => {
  it('two handoffs with identical bodies produce identical payload_shas', () => {
    const args = {
      runId: 'wr_01',
      generation: 0,
      fromStage: 'analysis',
      toStage: 'plan',
      upstreamRef: 'artifact://requirement-spec/abc',
      payload: {
        kind: 'analysis_to_plan' as const,
        data: {
          requirementSpecDigest: sha64('a'),
          summary: 'x',
        },
      },
      now: new Date('2026-07-03T00:00:00Z'),
    };
    const h1 = buildHandoff(args);
    const h2 = buildHandoff(args);
    expect(h1.payloadSha).toBe(h2.payloadSha);
    expect(h1.handoffSha).toBe(h2.handoffSha);
  });
});

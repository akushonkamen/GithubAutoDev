/**
 * Plan comment renderer + approval command hint — T-M4-005,
 * spec §14.2 + §14.3.
 *
 * Locks the contracts:
 *   - Approval hint is always `/approve-plan <plan_id>@<plan_sha>`.
 *   - Hint parser is the inverse of the renderer.
 *   - Status marker is appended so the runner can UPDATE in place
 *     (no spam of new comments).
 *   - Comment body never interpolates raw issue body (trusted fields only).
 */

import { describe, expect, it } from 'vitest';
import type { ImplementationPlan } from '../implementation-plan.js';
import { buildImplementationPlan } from '../implementation-plan.js';
import {
  APPROVAL_COMMAND_REGEX,
  parseApprovalCommand,
  renderApprovalCommandHint,
  renderPlanCommentBody,
  renderStatusUpdateBody,
} from '../plan-comment.js';
import type { RequirementSpec } from '../requirement-spec.js';
import type { RuleEvaluationResult } from '../risk-classifier.js';

function mkSpec(overrides: Partial<RequirementSpec> = {}): RequirementSpec {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    issueSnapshotSha: 'a'.repeat(64),
    summary: 'fix deploy',
    goals: ['deploy works'],
    nonGoals: [],
    acceptanceCriteria: [
      { description: 'deploy runs', verification: 'automated' },
      { description: 'rollback documented', verification: 'manual' },
    ],
    risks: [],
    openQuestions: [],
    generation: 0,
    createdAt: '2026-07-03T00:00:00.000Z',
    ...overrides,
  };
}

function mkPlan(spec: RequirementSpec): ImplementationPlan {
  return buildImplementationPlan({
    spec,
    requirementSpecDigest: spec.issueSnapshotSha,
    planId: 'plan-0001',
    tasks: [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'patch deploy script',
        allowedPaths: ['scripts/deploy.sh'],
        forbiddenPaths: [],
        dependsOn: [],
        agent: 'implementer',
        modelTier: 'standard',
      },
      {
        id: 't2',
        satisfies: ['ac-2'],
        description: 'write rollback doc',
        allowedPaths: ['docs/rollback.md'],
        forbiddenPaths: [],
        dependsOn: ['t1'],
        agent: 'implementer',
        modelTier: 'low',
      },
    ],
    now: new Date('2026-07-03T00:00:00Z'),
  });
}

const lowRisk: RuleEvaluationResult = {
  pathSeverity: 'low',
  dependencySeverity: 'low',
  severity: 'low',
  matches: [],
};

const highRisk: RuleEvaluationResult = {
  pathSeverity: 'high',
  dependencySeverity: 'low',
  severity: 'high',
  matches: [{ pattern: 'infra/', severity: 'high', bucket: 'infra' }],
};

describe('renderApprovalCommandHint (T-M4-005, spec §14.3)', () => {
  it('renders /approve-plan plan_id@plan_sha', () => {
    expect(renderApprovalCommandHint({ planId: 'plan-0001', planSha: 'b'.repeat(64) })).toBe(
      `/approve-plan plan-0001@${'b'.repeat(64)}`,
    );
  });

  it('rejects empty plan_id', () => {
    expect(() => renderApprovalCommandHint({ planId: '', planSha: 'b'.repeat(64) })).toThrow();
  });

  it('rejects empty plan_sha', () => {
    expect(() => renderApprovalCommandHint({ planId: 'plan-0001', planSha: '' })).toThrow();
  });
});

describe('APPROVAL_COMMAND_REGEX + parseApprovalCommand (T-M4-005)', () => {
  it('parses a canonical /approve-plan command', () => {
    const sha = 'b'.repeat(64);
    const parsed = parseApprovalCommand(`/approve-plan plan-0001@${sha}`);
    expect(parsed).toEqual({ planId: 'plan-0001', planSha: sha });
  });

  it('returns null for a command missing the @sha binding', () => {
    expect(parseApprovalCommand('/approve-plan plan-0001')).toBeNull();
  });

  it('returns null for an @sha of the wrong length', () => {
    expect(parseApprovalCommand('/approve-plan plan-0001=short')).toBeNull();
  });

  it('returns null for a non-approval line', () => {
    expect(parseApprovalCommand('looks good to me')).toBeNull();
  });

  it('round-trips render → parse', () => {
    const hint = renderApprovalCommandHint({
      planId: 'plan-0007',
      planSha: 'c'.repeat(64),
    });
    const parsed = parseApprovalCommand(hint);
    expect(parsed).toEqual({ planId: 'plan-0007', planSha: 'c'.repeat(64) });
  });

  it('regex rejects a sha shorter than 64 hex chars', () => {
    expect(APPROVAL_COMMAND_REGEX.test('/approve-plan plan-0001@abc')).toBe(false);
  });
});

describe('renderPlanCommentBody (T-M4-005, spec §14.2)', () => {
  const marker = '<!-- cgao:status-comment-marker run=wr_01 status=plan_ready nonce=n mac=m -->';

  it('embeds the verbatim /approve-plan plan_id@plan_sha hint', () => {
    const spec = mkSpec();
    const plan = mkPlan(spec);
    const body = renderPlanCommentBody({
      spec,
      plan,
      deterministicRisk: lowRisk,
      statusMarker: marker,
      status: 'ready',
    });
    expect(body).toContain(`/approve-plan ${plan.planId}@${plan.planSha}`);
  });

  it('appends the status marker so the runner can update in place', () => {
    const spec = mkSpec();
    const plan = mkPlan(spec);
    const body = renderPlanCommentBody({
      spec,
      plan,
      deterministicRisk: lowRisk,
      statusMarker: marker,
      status: 'ready',
    });
    expect(body).toContain(marker);
  });

  it('renders the risk floor (cannot be lowered)', () => {
    const spec = mkSpec();
    const plan = mkPlan(spec);
    const body = renderPlanCommentBody({
      spec,
      plan,
      deterministicRisk: highRisk,
      statusMarker: marker,
      status: 'ready',
    });
    expect(body).toContain('Risk floor');
    expect(body).toContain('`high`');
    expect(body).toContain('infra/');
  });

  it('renders the criterion → task table covering every criterion', () => {
    const spec = mkSpec();
    const plan = mkPlan(spec);
    const body = renderPlanCommentBody({
      spec,
      plan,
      deterministicRisk: lowRisk,
      statusMarker: marker,
      status: 'ready',
    });
    expect(body).toContain('ac-1');
    expect(body).toContain('ac-2');
    expect(body).toContain('t1');
    expect(body).toContain('t2');
  });

  it('marks an unmapped criterion as _unmapped_ (UI can flag it)', () => {
    const spec = mkSpec();
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: spec.issueSnapshotSha,
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'patch deploy script',
          allowedPaths: ['scripts/deploy.sh'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
        {
          id: 't2',
          satisfies: ['ac-2'],
          description: 'rollback doc',
          allowedPaths: ['docs/rollback.md'],
          forbiddenPaths: [],
          dependsOn: ['t1'],
          agent: 'implementer',
          modelTier: 'low',
        },
      ],
      now: new Date('2026-07-03T00:00:00Z'),
    });
    const body = renderPlanCommentBody({
      spec: {
        ...spec,
        acceptanceCriteria: [
          ...spec.acceptanceCriteria,
          { description: 'extra', verification: 'manual' },
        ],
      },
      plan,
      deterministicRisk: lowRisk,
      statusMarker: marker,
      status: 'ready',
    });
    expect(body).toContain('_unmapped_');
  });
});

describe('renderStatusUpdateBody (T-M4-005, no-flood)', () => {
  const marker = '<!-- cgao:status-comment-marker run=wr_01 status=in_progress nonce=n mac=m -->';

  it('wraps a status-only message with the marker — no plan body, no approval hint', () => {
    const body = renderStatusUpdateBody({
      marker,
      status: 'in_progress',
      message: 'cgao is executing task t1',
    });
    expect(body).toContain('## cgao status');
    expect(body).toContain('cgao is executing task t1');
    expect(body).toContain(marker);
    expect(body).not.toContain('/approve-plan');
  });
});

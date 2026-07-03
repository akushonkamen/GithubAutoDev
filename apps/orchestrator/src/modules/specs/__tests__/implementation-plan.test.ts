/**
 * ImplementationPlan generator + validator — T-M4-004,
 * spec §12.5.
 *
 * Locks the contracts:
 *   - Every acceptance criterion maps to ≥1 task.
 *   - Each task has allowed_paths/forbidden_paths/depends_on/agent/model_tier.
 *   - plan_sha is deterministic sha256 over canonical JSON.
 *   - Validator rejects: unmapped criteria, unknown deps, cycles,
 *     path-in-both-lists, missing forbidden protected paths, plan_sha
 *     mismatch, insufficient model tier.
 */

import { describe, expect, it } from 'vitest';
import {
  PLAN_PROMPT_TEMPLATE,
  PlanValidator,
  acceptanceCriterionId,
  buildImplementationPlan,
  computePlanDigest,
  implementationPlanSchema,
  minModelTierForSeverity,
  modelTierRank,
  renderPlanPrompt,
} from '../implementation-plan.js';
import type { RequirementSpec } from '../requirement-spec.js';
import type { RuleEvaluationResult } from '../risk-classifier.js';

function mkSpec(overrides: Partial<RequirementSpec> = {}): RequirementSpec {
  return {
    repo: 'cgao/test',
    issueNumber: 1,
    issueSnapshotSha: 'a'.repeat(64),
    summary: 'fix the deploy',
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

const lowRisk: RuleEvaluationResult = {
  pathSeverity: 'low',
  dependencySeverity: 'low',
  severity: 'low',
  matches: [],
};

describe('acceptanceCriterionId (T-M4-004)', () => {
  it('returns ac-<n+1> for each criterion', () => {
    const spec = mkSpec();
    expect(acceptanceCriterionId(spec, 0)).toBe('ac-1');
    expect(acceptanceCriterionId(spec, 1)).toBe('ac-2');
  });
});

describe('computePlanDigest (T-M4-004)', () => {
  it('is deterministic for the same inputs', () => {
    const spec = mkSpec();
    const tasks = [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'do it',
        allowedPaths: ['src/deploy.ts'],
        forbiddenPaths: [],
        dependsOn: [],
        agent: 'implementer' as const,
        modelTier: 'standard' as const,
      },
    ];
    const args = {
      repo: spec.repo,
      issueNumber: spec.issueNumber,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks,
      generation: 0,
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    expect(computePlanDigest(args)).toBe(computePlanDigest(args));
  });

  it('changes when task order is reshuffled only if it changes content', () => {
    const base = {
      repo: 'cgao/test',
      issueNumber: 1,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      generation: 0,
      createdAt: '2026-07-03T00:00:00.000Z',
    };
    const t1 = {
      id: 't1',
      satisfies: ['ac-1'],
      description: 'd1',
      allowedPaths: ['a'],
      forbiddenPaths: [],
      dependsOn: [],
      agent: 'implementer' as const,
      modelTier: 'standard' as const,
    };
    const t2 = { ...t1, id: 't2', description: 'd2' };
    expect(computePlanDigest({ ...base, tasks: [t1, t2] })).not.toBe(
      computePlanDigest({ ...base, tasks: [t2, t1] }),
    );
  });
});

describe('buildImplementationPlan (T-M4-004)', () => {
  it('round-trips through the zod schema', () => {
    const spec = mkSpec();
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1', 'ac-2'],
          description: 'do it',
          allowedPaths: ['src/deploy.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    expect(implementationPlanSchema.parse(plan)).toEqual(plan);
  });

  it('plan_sha matches recomputed digest', () => {
    const spec = mkSpec();
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'do it',
          allowedPaths: ['src/deploy.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
      now: new Date('2026-07-03T00:00:00Z'),
    });
    const recomputed = computePlanDigest({
      createdAt: plan.createdAt,
      generation: plan.generation,
      issueNumber: plan.issueNumber,
      planId: plan.planId,
      repo: plan.repo,
      requirementSpecDigest: plan.requirementSpecDigest,
      tasks: plan.tasks,
    });
    expect(plan.planSha).toBe(recomputed);
  });
});

describe('PlanValidator (T-M4-004)', () => {
  const validator = new PlanValidator();

  it('returns no findings for a clean plan covering all criteria', () => {
    const spec = mkSpec();
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'deploy',
          allowedPaths: ['src/deploy.ts'],
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
    });
    const findings = validator.validate({ spec, plan, deterministicRisk: lowRisk });
    expect(findings).toEqual([]);
  });

  it('flags an unmapped acceptance criterion', () => {
    const spec = mkSpec();
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'deploy',
          allowedPaths: ['src/deploy.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    const findings = validator.validate({ spec, plan, deterministicRisk: lowRisk });
    expect(findings.some((f) => f.code === 'unmapped_criterion' && f.level === 'error')).toBe(true);
  });

  it('rejects unknown dependency', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'x',
          allowedPaths: ['src/x.ts'],
          forbiddenPaths: [],
          dependsOn: ['ghost'],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    const findings = validator.validate({ spec, plan, deterministicRisk: lowRisk });
    expect(findings.some((f) => f.code === 'unknown_dependency')).toBe(true);
  });

  it('rejects a cycle', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const tasks = [
      {
        id: 't1',
        satisfies: ['ac-1'],
        description: 'a',
        allowedPaths: ['x'],
        forbiddenPaths: [],
        dependsOn: ['t2'],
        agent: 'implementer' as const,
        modelTier: 'standard' as const,
      },
      {
        id: 't2',
        satisfies: ['ac-1'],
        description: 'b',
        allowedPaths: ['y'],
        forbiddenPaths: [],
        dependsOn: ['t1'],
        agent: 'tester' as const,
        modelTier: 'standard' as const,
      },
    ];
    const rebuilt = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks,
    });
    const findings = validator.validate({ spec, plan: rebuilt, deterministicRisk: lowRisk });
    expect(findings.some((f) => f.code === 'dependency_cycle')).toBe(true);
  });

  it('rejects a path in both allowed and forbidden lists', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'x',
          allowedPaths: ['src/auth/login.ts'],
          forbiddenPaths: ['src/auth/login.ts'],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    const findings = validator.validate({ spec, plan, deterministicRisk: lowRisk });
    expect(findings.some((f) => f.code === 'path_in_both_lists')).toBe(true);
  });

  it('rejects a tampered plan_sha', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'x',
          allowedPaths: ['src/x.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    const tampered: typeof plan = { ...plan, planSha: '0'.repeat(64) };
    const findings = validator.validate({ spec, plan: tampered, deterministicRisk: lowRisk });
    expect(findings.some((f) => f.code === 'plan_sha_mismatch')).toBe(true);
  });

  it('requires forbiddenPaths when the classifier flagged a protected path', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'fix docs',
          allowedPaths: ['docs/x.md'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'standard',
        },
      ],
    });
    const risk: RuleEvaluationResult = {
      pathSeverity: 'critical',
      dependencySeverity: 'low',
      severity: 'critical',
      matches: [{ pattern: 'src/auth/', severity: 'critical', bucket: 'auth' }],
    };
    const findings = validator.validate({ spec, plan, deterministicRisk: risk });
    expect(findings.some((f) => f.code === 'missing_forbidden_path' && f.level === 'error')).toBe(
      true,
    );
  });

  it('accepts explicit allow-list + sufficient model tier', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'patch auth',
          allowedPaths: ['src/auth/jwt.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'frontier',
        },
      ],
    });
    const risk: RuleEvaluationResult = {
      pathSeverity: 'critical',
      dependencySeverity: 'low',
      severity: 'critical',
      matches: [{ pattern: 'src/auth/', severity: 'critical', bucket: 'auth' }],
    };
    const findings = validator.validate({ spec, plan, deterministicRisk: risk });
    expect(findings).toEqual([]);
  });

  it('rejects explicit allow-list with insufficient model tier', () => {
    const spec = mkSpec({ acceptanceCriteria: [{ description: 'x', verification: 'manual' }] });
    const plan = buildImplementationPlan({
      spec,
      requirementSpecDigest: 'b'.repeat(64),
      planId: 'plan-0001',
      tasks: [
        {
          id: 't1',
          satisfies: ['ac-1'],
          description: 'patch auth with weak model',
          allowedPaths: ['src/auth/jwt.ts'],
          forbiddenPaths: [],
          dependsOn: [],
          agent: 'implementer',
          modelTier: 'low',
        },
      ],
    });
    const risk: RuleEvaluationResult = {
      pathSeverity: 'critical',
      dependencySeverity: 'low',
      severity: 'critical',
      matches: [{ pattern: 'src/auth/', severity: 'critical', bucket: 'auth' }],
    };
    const findings = validator.validate({ spec, plan, deterministicRisk: risk });
    expect(findings.some((f) => f.code === 'insufficient_model_tier')).toBe(true);
  });
});

describe('minModelTierForSeverity + modelTierRank (T-M4-004)', () => {
  it('maps low/medium/high/critical to low/standard/high/frontier', () => {
    expect(minModelTierForSeverity('low')).toBe('low');
    expect(minModelTierForSeverity('medium')).toBe('standard');
    expect(minModelTierForSeverity('high')).toBe('high');
    expect(minModelTierForSeverity('critical')).toBe('frontier');
  });

  it('orders low < standard < high < frontier', () => {
    expect(modelTierRank('low')).toBeLessThan(modelTierRank('standard'));
    expect(modelTierRank('standard')).toBeLessThan(modelTierRank('high'));
    expect(modelTierRank('high')).toBeLessThan(modelTierRank('frontier'));
  });
});

describe('PLAN_PROMPT_TEMPLATE + renderPlanPrompt (T-M4-004)', () => {
  it('places the issue body inside the untrusted envelope', () => {
    const prompt = renderPlanPrompt({
      requirementSpecJson: '{"summary":"x"}',
      title: 't',
      body: 'inject-me-please',
    });
    const begin = prompt.indexOf('<<<UNTRUSTED_CONTENT BEGIN>>>');
    const end = prompt.indexOf('<<<UNTRUSTED_CONTENT END>>>');
    expect(begin).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(begin);
    expect(prompt.slice(begin, end)).toContain('inject-me-please');
  });

  it('does NOT inline the body into the system instruction', () => {
    const prompt = renderPlanPrompt({
      requirementSpecJson: '{}',
      title: 't',
      body: 'leak-marker',
    });
    const before = prompt.slice(0, prompt.indexOf('<<<UNTRUSTED_CONTENT BEGIN>>>'));
    expect(before).not.toContain('leak-marker');
  });

  it('embeds the RequirementSpec in the trusted region', () => {
    expect(PLAN_PROMPT_TEMPLATE).toContain('{{requirementSpecJson}}');
    expect(PLAN_PROMPT_TEMPLATE).toContain('TRUSTED');
  });
});

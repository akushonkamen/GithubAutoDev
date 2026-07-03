/**
 * Deterministic risk classifier — T-M4-003, spec §12.11 + §18.
 *
 * Locks the contracts:
 *   - auth/payment paths trigger critical.
 *   - infra/.github/.cgao/.claude/security-tests trigger high.
 *   - dependency changes (jsonwebtoken/passport/oauth/claude-code) trigger high/critical.
 *   - Combined severity is max(pathSeverity, dependencySeverity).
 *   - enforceFloor bumps LLM-declared severity up to the deterministic floor.
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PROTECTED_PATH_RULES,
  DependencyChangeRules,
  type PathMatch,
  ProtectedPathRules,
  RiskClassifier,
  maxSeverity,
  severityRank,
} from '../risk-classifier.js';

describe('DEFAULT_PROTECTED_PATH_RULES (T-M4-003, spec §12.11)', () => {
  it('marks auth paths as critical', () => {
    const authRules = DEFAULT_PROTECTED_PATH_RULES.filter((r) => r.bucket === 'auth');
    expect(authRules.length).toBeGreaterThan(0);
    for (const r of authRules) expect(r.severity).toBe('critical');
  });

  it('marks payment paths as critical', () => {
    const paymentRules = DEFAULT_PROTECTED_PATH_RULES.filter((r) => r.bucket === 'payment');
    expect(paymentRules.length).toBeGreaterThan(0);
    for (const r of paymentRules) expect(r.severity).toBe('critical');
  });

  it('marks infra / ci / cgao-config / security-tests as high', () => {
    const highBuckets = ['infra', 'ci', 'cgao-config', 'security-tests'];
    for (const bucket of highBuckets) {
      const rules = DEFAULT_PROTECTED_PATH_RULES.filter((r) => r.bucket === bucket);
      expect(rules.length).toBeGreaterThan(0);
      for (const r of rules) expect(r.severity).toBe('high');
    }
  });

  it('covers .github/workflows/, .cgao/, .claude/ (spec §12.11)', () => {
    const patterns = DEFAULT_PROTECTED_PATH_RULES.map((r) => r.pattern);
    expect(patterns).toContain('.github/workflows/');
    expect(patterns).toContain('.cgao/');
    expect(patterns).toContain('.claude/');
  });
});

describe('ProtectedPathRules.evaluate (T-M4-003)', () => {
  const rules = new ProtectedPathRules();

  it('matches an auth path with critical severity', () => {
    const matches = rules.evaluate(['apps/auth/src/jwt.ts']);
    expect(matches.some((m) => m.bucket === 'auth' && m.severity === 'critical')).toBe(true);
  });

  it('matches a payment path with critical severity', () => {
    const matches = rules.evaluate(['packages/payment/stripe.ts']);
    expect(matches.some((m) => m.bucket === 'payment' && m.severity === 'critical')).toBe(true);
  });

  it('matches .github/workflows/ with high severity', () => {
    const matches = rules.evaluate(['.github/workflows/deploy.yml']);
    expect(matches.some((m) => m.bucket === 'ci' && m.severity === 'high')).toBe(true);
  });

  it('matches .cgao/ and .claude/ with high severity', () => {
    const matches = rules.evaluate(['.cgao/config.yml', '.claude/settings.json']);
    expect(matches.some((m) => m.bucket === 'cgao-config' && m.severity === 'high')).toBe(true);
  });

  it('returns no matches for benign paths', () => {
    const matches = rules.evaluate(['docs/readme.md', 'src/components/Button.tsx']);
    expect(matches).toHaveLength(0);
  });
});

describe('DependencyChangeRules.evaluate (T-M4-003)', () => {
  const rules = new DependencyChangeRules();

  it('matches jsonwebtoken/passport/oauth as critical', () => {
    const matches = rules.evaluate([
      { ecosystem: 'npm', package: 'jsonwebtoken' },
      { ecosystem: 'npm', package: 'passport-google-oauth20' },
      { ecosystem: 'npm', package: 'oauth' },
    ]);
    const criticals = matches.filter((m) => m.severity === 'critical');
    expect(criticals.length).toBeGreaterThanOrEqual(3);
  });

  it('matches claude-code / @cgao/runner as high (runner supply chain)', () => {
    const matches = rules.evaluate([
      { ecosystem: 'npm', package: 'claude-code' },
      { ecosystem: 'npm', package: '@cgao/runner' },
    ]);
    const highs = matches.filter((m) => m.severity === 'high' && m.bucket === 'runner-dep');
    expect(highs.length).toBeGreaterThanOrEqual(2);
  });

  it('respects ecosystem filter when matching', () => {
    const matches = rules.evaluate([{ ecosystem: 'pip', package: 'jsonwebtoken' }]);
    // ecosystem '*' rules match any, so jsonwebtoken still fires
    expect(matches.some((m) => m.bucket === 'auth-dep')).toBe(true);
  });
});

describe('severityRank + maxSeverity (T-M4-003)', () => {
  it('orders low < medium < high < critical', () => {
    expect(severityRank('low')).toBeLessThan(severityRank('medium'));
    expect(severityRank('medium')).toBeLessThan(severityRank('high'));
    expect(severityRank('high')).toBeLessThan(severityRank('critical'));
  });

  it('maxSeverity picks the highest rank', () => {
    expect(maxSeverity(['low', 'medium', 'high'])).toBe('high');
    expect(maxSeverity(['low', 'critical'])).toBe('critical');
    expect(maxSeverity([])).toBe('low');
  });
});

describe('RiskClassifier.classify (T-M4-003)', () => {
  const classifier = new RiskClassifier();

  it('returns low for benign paths and no dependency changes', () => {
    const result = classifier.classify({
      proposedPaths: ['docs/foo.md'],
      dependencyChanges: [],
    });
    expect(result.severity).toBe('low');
    expect(result.pathSeverity).toBe('low');
    expect(result.dependencySeverity).toBe('low');
    expect(result.matches).toHaveLength(0);
  });

  it('combines path + dependency severity as the max', () => {
    const result = classifier.classify({
      proposedPaths: ['infra/terraform/main.tf'],
      dependencyChanges: [{ ecosystem: 'npm', package: 'jsonwebtoken' }],
    });
    expect(result.pathSeverity).toBe('high');
    expect(result.dependencySeverity).toBe('critical');
    expect(result.severity).toBe('critical');
  });

  it('paths alone can drive severity to critical (auth/payment)', () => {
    const result = classifier.classify({
      proposedPaths: ['apps/auth/login.ts'],
      dependencyChanges: [],
    });
    expect(result.pathSeverity).toBe('critical');
    expect(result.severity).toBe('critical');
  });

  it('exposes match details for audit', () => {
    const result = classifier.classify({
      proposedPaths: ['.cgao/policy.yml'],
      dependencyChanges: [],
    });
    expect(result.matches.length).toBeGreaterThan(0);
    const match = result.matches[0] as PathMatch;
    expect(match.pattern).toBe('.cgao/');
    expect(match.bucket).toBe('cgao-config');
    expect(match.severity).toBe('high');
  });
});

describe('RiskClassifier.enforceFloor (T-M4-003, spec §12.11)', () => {
  const classifier = new RiskClassifier();

  it("bumps LLM-declared 'low' up to the deterministic floor (critical)", () => {
    const deterministic = classifier.classify({
      proposedPaths: ['apps/auth/login.ts'],
      dependencyChanges: [],
    });
    const declared = [
      { declaredSeverity: 'low' as const },
      { declaredSeverity: 'medium' as const },
    ];
    classifier.enforceFloor({ declared, deterministic });
    for (const r of declared) {
      expect(r.declaredSeverity).toBe('critical');
    }
  });

  it('does NOT lower a LLM-declared severity above the floor', () => {
    const deterministic = classifier.classify({
      proposedPaths: ['infra/foo.tf'],
      dependencyChanges: [],
    });
    expect(deterministic.severity).toBe('high');
    const declared = [{ declaredSeverity: 'critical' as const }];
    classifier.enforceFloor({ declared, deterministic });
    expect(declared[0]?.declaredSeverity).toBe('critical');
  });

  it('leaves declared severities alone when the floor is low', () => {
    const deterministic = classifier.classify({
      proposedPaths: ['docs/readme.md'],
      dependencyChanges: [],
    });
    const declared = [
      { declaredSeverity: 'low' as const },
      { declaredSeverity: 'medium' as const },
      { declaredSeverity: 'high' as const },
      { declaredSeverity: 'critical' as const },
    ];
    const original = declared.map((r) => r.declaredSeverity);
    classifier.enforceFloor({ declared, deterministic });
    expect(declared.map((r) => r.declaredSeverity)).toEqual(original);
  });
});

describe('LLM-cannot-lower end-to-end (T-M4-003, spec §18)', () => {
  it('an LLM that declares low against an auth path is overridden', () => {
    const classifier = new RiskClassifier();
    const deterministic = classifier.classify({
      proposedPaths: ['src/auth/session.ts'],
      dependencyChanges: [{ ecosystem: 'npm', package: 'passport' }],
    });
    expect(deterministic.severity).toBe('critical');

    const llmDeclaredRisks = [
      { label: 'trivial-change', description: 'looks safe', declaredSeverity: 'low' as const },
    ];
    classifier.enforceFloor({ declared: llmDeclaredRisks, deterministic });
    expect(llmDeclaredRisks[0]?.declaredSeverity).toBe('critical');
  });
});

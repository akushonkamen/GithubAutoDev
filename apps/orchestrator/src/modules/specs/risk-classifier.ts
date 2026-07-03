/**
 * Deterministic risk classifier — T-M4-003, spec §12.11 + §18.
 *
 * Risk is computed DETERMINISTICALLY from the proposed task's file
 * paths and dependency changes. The LLM cannot lower it. The result
 * is merged into the RequirementSpec.risks array as an authoritative
 * entry (declaredSeverity = the max of any deterministic match),
 * overriding any lower value the LLM tried to set.
 *
 * Contracts (spec §12.11):
 *
 *   - auth/payment/infra/.github/.cgao/.claude/dependency files
 *     trigger high or critical.
 *   - The classifier output is AUTHORITATIVE — the orchestrator's
 *     PlanValidator rejects plans that propose touching those paths
 *     without an adequate risk level.
 */

import { z } from 'zod';

export const riskSeveritySchema = z.enum(['low', 'medium', 'high', 'critical']);
export type RiskSeverity = z.infer<typeof riskSeveritySchema>;

export interface PathMatch {
  /** Pattern that fired (e.g. '.github/workflows/**'). */
  pattern: string;
  /** Severity assigned by this rule. */
  severity: RiskSeverity;
  /** Bucket label (auth, payment, infra, ci, cgao-config, deps). */
  bucket: string;
}

export interface RuleEvaluationResult {
  /** Severity for the proposed file paths (max of matches, or 'low'). */
  pathSeverity: RiskSeverity;
  /** Severity for the proposed dependency changes (or 'low'). */
  dependencySeverity: RiskSeverity;
  /** Combined severity (max of path + dependency). */
  severity: RiskSeverity;
  /** Individual pattern matches, for audit + plan comment. */
  matches: readonly PathMatch[];
}

/**
 * Default protected-path rules. Each pattern is a glob-style prefix
 * with optional ** wildcards. The classifier uses them as plain
 * substring + suffix matches — no real globbing needed at this layer
 * because the rules are about directories.
 */
export const DEFAULT_PROTECTED_PATH_RULES: ReadonlyArray<{
  pattern: string;
  severity: RiskSeverity;
  bucket: string;
}> = Object.freeze([
  // Authentication / authorization / session — critical.
  { pattern: 'apps/auth/', severity: 'critical', bucket: 'auth' },
  { pattern: 'packages/auth/', severity: 'critical', bucket: 'auth' },
  { pattern: 'src/auth/', severity: 'critical', bucket: 'auth' },
  { pattern: 'src/session/', severity: 'critical', bucket: 'auth' },
  { pattern: 'middleware/auth', severity: 'critical', bucket: 'auth' },
  // Payment — critical.
  { pattern: 'apps/payment/', severity: 'critical', bucket: 'payment' },
  { pattern: 'packages/payment/', severity: 'critical', bucket: 'payment' },
  { pattern: 'src/payment/', severity: 'critical', bucket: 'payment' },
  { pattern: 'src/billing/', severity: 'critical', bucket: 'payment' },
  // Infra — high.
  { pattern: 'infra/', severity: 'high', bucket: 'infra' },
  { pattern: 'terraform/', severity: 'high', bucket: 'infra' },
  { pattern: 'k8s/', severity: 'high', bucket: 'infra' },
  { pattern: 'deploy/', severity: 'high', bucket: 'infra' },
  // CI / workflows — high (supply chain).
  { pattern: '.github/workflows/', severity: 'high', bucket: 'ci' },
  // cgao / claude config — high (prompt-injection surface).
  { pattern: '.cgao/', severity: 'high', bucket: 'cgao-config' },
  { pattern: '.claude/', severity: 'high', bucket: 'cgao-config' },
  { pattern: 'cgao.local.yml', severity: 'high', bucket: 'cgao-config' },
  // Security regression corpus.
  { pattern: 'tests/security/', severity: 'high', bucket: 'security-tests' },
]);

/**
 * Default dependency-change rules. A bump in any of these triggers
 * at least high — the version delta is captured as a match.
 */
export const DEFAULT_DEPENDENCY_RULES: ReadonlyArray<{
  /** Ecosystem. */
  ecosystem: 'npm' | 'pip' | 'go' | 'cargo' | '*';
  /** Package name pattern. */
  packagePattern: string;
  severity: RiskSeverity;
  bucket: string;
}> = Object.freeze([
  // Auth / crypto libs — critical.
  { ecosystem: '*', packagePattern: 'jsonwebtoken', severity: 'critical', bucket: 'auth-dep' },
  { ecosystem: '*', packagePattern: 'passport', severity: 'critical', bucket: 'auth-dep' },
  { ecosystem: '*', packagePattern: 'oauth', severity: 'critical', bucket: 'auth-dep' },
  { ecosystem: '*', packagePattern: 'crypto', severity: 'high', bucket: 'crypto-dep' },
  // Build / runner / supply chain — high.
  { ecosystem: '*', packagePattern: 'claude-code', severity: 'high', bucket: 'runner-dep' },
  { ecosystem: '*', packagePattern: '@cgao/runner', severity: 'high', bucket: 'runner-dep' },
  { ecosystem: '*', packagePattern: 'vitest', severity: 'medium', bucket: 'test-dep' },
]);

const SEVERITY_RANK: Record<RiskSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function severityRank(s: RiskSeverity): number {
  return SEVERITY_RANK[s];
}

export function maxSeverity(severities: Iterable<RiskSeverity>): RiskSeverity {
  let best: RiskSeverity = 'low';
  for (const s of severities) {
    if (severityRank(s) > severityRank(best)) best = s;
  }
  return best;
}

export class ProtectedPathRules {
  constructor(
    private readonly rules: ReadonlyArray<{
      pattern: string;
      severity: RiskSeverity;
      bucket: string;
    }> = DEFAULT_PROTECTED_PATH_RULES,
  ) {}

  evaluate(proposedPaths: readonly string[]): readonly PathMatch[] {
    const out: PathMatch[] = [];
    for (const path of proposedPaths) {
      for (const rule of this.rules) {
        if (path.includes(rule.pattern)) {
          out.push({
            pattern: rule.pattern,
            severity: rule.severity,
            bucket: rule.bucket,
          });
        }
      }
    }
    return out;
  }
}

export class DependencyChangeRules {
  constructor(
    private readonly rules: ReadonlyArray<{
      ecosystem: string;
      packagePattern: string;
      severity: RiskSeverity;
      bucket: string;
    }> = DEFAULT_DEPENDENCY_RULES,
  ) {}

  evaluate(changes: ReadonlyArray<{ ecosystem: string; package: string }>): readonly PathMatch[] {
    const out: PathMatch[] = [];
    for (const change of changes) {
      for (const rule of this.rules) {
        const ecoMatch = rule.ecosystem === '*' || rule.ecosystem === change.ecosystem;
        if (!ecoMatch) continue;
        const pkgMatch = change.package.includes(rule.packagePattern);
        if (!pkgMatch) continue;
        out.push({
          pattern: `${change.ecosystem}:${rule.packagePattern}`,
          severity: rule.severity,
          bucket: rule.bucket,
        });
      }
    }
    return out;
  }
}

export interface RiskClassifierInput {
  proposedPaths: readonly string[];
  dependencyChanges: ReadonlyArray<{ ecosystem: string; package: string }>;
}

export class RiskClassifier {
  constructor(
    private readonly pathRules: ProtectedPathRules = new ProtectedPathRules(),
    private readonly depRules: DependencyChangeRules = new DependencyChangeRules(),
  ) {}

  classify(input: RiskClassifierInput): RuleEvaluationResult {
    const pathMatches = this.pathRules.evaluate(input.proposedPaths);
    const depMatches = this.depRules.evaluate(input.dependencyChanges);
    const pathSeverity = maxSeverity(pathMatches.map((m) => m.severity));
    const depSeverity = maxSeverity(depMatches.map((m) => m.severity));
    return {
      pathSeverity,
      dependencySeverity: depSeverity,
      severity: maxSeverity([pathSeverity, depSeverity]),
      matches: [...pathMatches, ...depMatches],
    };
  }

  /**
   * Enforce the "LLM cannot lower" rule on a RequirementSpec.risks
   * array. The deterministic result wins: any risk entry whose
   * declaredSeverity is below the classifier output is bumped up.
   */
  enforceFloor(args: {
    declared: ReadonlyArray<{ declaredSeverity: RiskSeverity }>;
    deterministic: RuleEvaluationResult;
  }): void {
    const floor = args.deterministic.severity;
    const floorRank = severityRank(floor);
    for (const r of args.declared) {
      if (severityRank(r.declaredSeverity) < floorRank) {
        r.declaredSeverity = floor;
      }
    }
  }
}

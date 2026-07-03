/**
 * SCA (software-composition-analysis) hook — T-M7-005, spec §12.11 / §18.
 *
 * Adapts DependencyChangeDetector findings into the cgao policy
 * surface by emitting PolicyDecision records and bumping the
 * RiskEscalationHook severity floor.
 *
 * Wiring: the orchestrator constructs one ScaHook per dev→review
 * handoff. It calls `evaluate()` with the changedFiles + trees; the
 * hook returns decisions + the new severity floor that the existing
 * RiskEscalationHook should enforce.
 */

import type { RiskEscalationHook, RiskSeverity } from '@cgao/runner-broker';
import {
  type DependencyRiskFinding,
  detectDependencyChanges,
} from './dependency-change-detector.js';

/** A single policy decision emitted by the SCA hook. */
export interface ScaPolicyDecision {
  /** Stable decision code; matches DependencyRiskKind. */
  code: string;
  /** Severity that should be enforced. */
  severity: RiskSeverity;
  /** Whether human approval is required before merge. */
  needsHumanApproval: boolean;
  /** Human-readable detail (trusted). */
  detail: string;
  /** Affected packages. */
  packages?: readonly string[];
}

export interface ScaEvaluationResult {
  decisions: readonly ScaPolicyDecision[];
  /** Max severity across all findings; null when no findings. */
  severityFloor: RiskSeverity | null;
  /** True if any decision requires human approval. */
  requiresHumanApproval: boolean;
}

const RANK: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

function maxSeverity(severities: Iterable<RiskSeverity>): RiskSeverity {
  let best: RiskSeverity = 'low';
  for (const s of severities) {
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}

/**
 * Map a DependencyRiskFinding to a PolicyDecision. Pure.
 */
export function findingToDecision(finding: DependencyRiskFinding): ScaPolicyDecision {
  const needsHuman =
    finding.severity === 'high' || finding.severity === 'critical';
  return {
    code: finding.kind,
    severity: finding.severity,
    needsHumanApproval: needsHuman,
    detail: finding.detail,
    packages: finding.packages,
  };
}

export interface ScaHookDeps {
  /** Optional risk escalation hook; when present, enforceFloor is called. */
  escalationHook?: RiskEscalationHook;
}

export class ScaHook {
  constructor(private readonly deps: ScaHookDeps = {}) {}

  /**
   * Evaluate the patch. Returns decisions + the severity floor that
   * should be applied to the run.
   */
  evaluate(args: {
    changedFiles: readonly string[];
    headTree: ReadonlyMap<string, string>;
    baseTree: ReadonlyMap<string, string>;
  }): ScaEvaluationResult {
    const findings = detectDependencyChanges(args);
    const decisions = findings.map(findingToDecision);
    const severityFloor =
      decisions.length === 0 ? null : maxSeverity(decisions.map((d) => d.severity));
    const requiresHumanApproval = decisions.some((d) => d.needsHumanApproval);

    return {
      decisions,
      severityFloor,
      requiresHumanApproval,
    };
  }

  /**
   * Evaluate + push the severity floor into the existing
   * RiskEscalationHook so the deterministic classifier enforces it.
   * Mirrors how protected-file escalation works (T-M5-007).
   */
  evaluateAndEscalate(args: {
    changedFiles: readonly string[];
    headTree: ReadonlyMap<string, string>;
    baseTree: ReadonlyMap<string, string>;
    declared: ReadonlyArray<{ declaredSeverity: RiskSeverity }>;
    deterministic: {
      severity: RiskSeverity;
      matches: ReadonlyArray<{ pattern: string; severity: RiskSeverity; bucket: string }>;
    };
  }): ScaEvaluationResult {
    const result = this.evaluate(args);
    if (this.deps.escalationHook && result.severityFloor) {
      // Synthesize a deterministic output whose severity is the SCA
      // floor, then let the escalation hook bump it.
      const floorDeterministic = {
        severity: result.severityFloor,
        matches: [
          ...args.deterministic.matches,
          ...result.decisions.map((d) => ({
            pattern: `sca:${d.code}`,
            severity: d.severity,
            bucket: 'dependency-sca',
          })),
        ],
      };
      this.deps.escalationHook.escalate({
        changedFiles: args.changedFiles,
        declared: args.declared,
        deterministic: floorDeterministic,
      });
    }
    return result;
  }
}

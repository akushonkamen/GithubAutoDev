/**
 * Risk escalation hook — T-M5-007, spec §12.11 / §18.
 *
 * When the agent's patch touches a protected file, the risk severity
 * is FORCED to ≥ high. The deterministic classifier's `enforceFloor`
 * semantics (spec §12.11 "LLM cannot lower") apply: even if the LLM
 * declared 'low', the hook bumps it.
 */

import type { ProtectedFileDetector } from './protected-file-detector.js';

export type RiskSeverity = 'low' | 'medium' | 'high' | 'critical';

const RANK: Record<RiskSeverity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface ClassifierOutput {
  severity: RiskSeverity;
  matches: ReadonlyArray<{ pattern: string; severity: RiskSeverity; bucket: string }>;
}

export interface EscalationResult {
  /** Severity after escalation (≥ high if protected files touched). */
  severity: RiskSeverity;
  /** Whether escalation fired. */
  escalated: boolean;
  /** Protected paths that triggered escalation. */
  triggeredBy: readonly string[];
}

/**
 * Local RiskClassifier-like interface. We avoid importing the
 * orchestrator's classifier to keep the runner-broker self-contained;
 * the orchestrator passes its own concrete instance when wiring.
 */
export interface RiskClassifierLike {
  enforceFloor(args: {
    declared: ReadonlyArray<{ declaredSeverity: RiskSeverity }>;
    deterministic: ClassifierOutput;
  }): void;
}

export class RiskEscalationHook {
  constructor(
    private readonly detector: ProtectedFileDetector,
    private readonly classifier: RiskClassifierLike,
  ) {}

  /**
   * Run escalation. `changedFiles` is the patch's file list. The hook
   * finds protected paths, computes the deterministic floor, and calls
   * classifier.enforceFloor to bump the LLM-declared severity.
   */
  escalate(args: {
    changedFiles: readonly string[];
    declared: ReadonlyArray<{ declaredSeverity: RiskSeverity }>;
    deterministic: ClassifierOutput;
  }): EscalationResult {
    const protectedTouched = args.changedFiles.filter((p) => this.detector.isProtected(p));
    if (protectedTouched.length === 0) {
      return { severity: args.deterministic.severity, escalated: false, triggeredBy: [] };
    }
    const floor: RiskSeverity =
      RANK[args.deterministic.severity] >= RANK.high ? args.deterministic.severity : 'high';
    const escalatedDeterministic: ClassifierOutput = {
      ...args.deterministic,
      severity: floor,
      matches: [
        ...args.deterministic.matches,
        ...protectedTouched.map((p) => ({
          pattern: p,
          severity: floor,
          bucket: 'protected-file',
        })),
      ],
    };
    this.classifier.enforceFloor({
      declared: args.declared,
      deterministic: escalatedDeterministic,
    });
    return { severity: floor, escalated: true, triggeredBy: protectedTouched };
  }
}

export function maxSeverity(severities: Iterable<RiskSeverity>): RiskSeverity {
  let best: RiskSeverity = 'low';
  for (const s of severities) {
    if (RANK[s] > RANK[best]) best = s;
  }
  return best;
}

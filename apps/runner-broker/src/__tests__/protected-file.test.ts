/**
 * T-M5-007 protected file policy regression.
 *
 * Contracts (spec §12.11 / §18):
 *   - .cgao/**, .claude/**, .github/**, package.json, lockfiles, scripts/**
 *     are detected as protected.
 *   - Touching a protected file forces risk severity to ≥ high.
 *   - Non-protected files do not escalate.
 */

import { describe, expect, it } from 'vitest';
import { ProtectedFileDetector } from '../policy/protected-file-detector.js';
import {
  type RiskClassifierLike,
  RiskEscalationHook,
  type RiskSeverity,
} from '../policy/risk-escalation-hook.js';

describe('T-M5-007 ProtectedFileDetector', () => {
  const detector = new ProtectedFileDetector();

  it.each([
    '.cgao/config.yml',
    '.claude/agents/foo.md',
    '.github/workflows/ci.yml',
    'package.json',
    'pnpm-lock.yaml',
    'package-lock.json',
    'yarn.lock',
    'scripts/build.sh',
  ])('flags %s as protected', (path) => {
    expect(detector.isProtected(path)).toBe(true);
  });

  it.each(['src/features/billing.ts', 'README.md', 'docs/guide.md'])('does NOT flag %s', (path) => {
    expect(detector.isProtected(path)).toBe(false);
  });
});

describe('T-M5-007 RiskEscalationHook', () => {
  const detector = new ProtectedFileDetector();

  it('forces severity to ≥ high when a protected file is touched', () => {
    const declared: { declaredSeverity: RiskSeverity }[] = [{ declaredSeverity: 'low' }];
    const classifier: RiskClassifierLike = {
      enforceFloor({ declared: d, deterministic }) {
        for (const r of d) {
          if (r.declaredSeverity !== deterministic.severity) {
            r.declaredSeverity = deterministic.severity;
          }
        }
      },
    };
    const hook = new RiskEscalationHook(detector, classifier);
    const result = hook.escalate({
      changedFiles: ['.cgao/config.yml', 'src/features/x.ts'],
      declared,
      deterministic: { severity: 'low', matches: [] },
    });
    expect(result.escalated).toBe(true);
    expect(result.severity).toBe('high');
    expect(result.triggeredBy).toEqual(['.cgao/config.yml']);
    expect(declared[0]?.declaredSeverity).toBe('high');
  });

  it('does not escalate when no protected files are touched', () => {
    const declared: { declaredSeverity: RiskSeverity }[] = [{ declaredSeverity: 'low' }];
    const classifier: RiskClassifierLike = {
      enforceFloor() {
        /* should not be called */
      },
    };
    const hook = new RiskEscalationHook(detector, classifier);
    const result = hook.escalate({
      changedFiles: ['src/features/billing.ts'],
      declared,
      deterministic: { severity: 'low', matches: [] },
    });
    expect(result.escalated).toBe(false);
    expect(result.triggeredBy).toEqual([]);
    // Severity unchanged.
    expect(result.severity).toBe('low');
    // declared was not mutated.
    expect(declared[0]?.declaredSeverity).toBe('low');
  });
});

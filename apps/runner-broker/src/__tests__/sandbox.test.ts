/**
 * T-M5-005 filesystem sandbox baseline regression.
 *
 * Contracts (spec §13.3):
 *   - forbidden path write → POLICY_DENIED
 *   - allowed path write succeeds
 *   - scripts in allowed paths cannot escape to forbidden paths
 */

import { describe, expect, it } from 'vitest';
import { PathWritePolicy } from '../sandbox/path-write-policy.js';
import { WriteOverlay } from '../sandbox/write-overlay.js';

const ROOT = '/repo';

function policy(): PathWritePolicy {
  return new PathWritePolicy({
    workspaceRoot: ROOT,
    allowedPaths: ['src/features/**'],
    forbiddenPaths: ['.cgao/**', 'secrets/**'],
  });
}

describe('T-M5-005 filesystem sandbox baseline', () => {
  it('denies a write to a forbidden path', () => {
    const p = policy();
    const res = p.isAllowed(`${ROOT}/.cgao/payload`);
    expect(res.decision).toBe('POLICY_DENIED');
  });

  it('allows a write inside an allowed path', () => {
    const p = policy();
    const res = p.isAllowed(`${ROOT}/src/features/billing.ts`);
    expect(res.decision).toBe('allow');
  });

  it('WriteOverlay records an allowed write and surfaces its path', () => {
    const overlay = new WriteOverlay(policy(), ROOT);
    const res = overlay.write(`${ROOT}/src/features/billing.ts`, 'export const x = 1;');
    expect(res.decision).toBe('allow');
    const entries = overlay.entriesList();
    expect(entries.length).toBe(1);
    expect(entries[0]?.path).toBe('src/features/billing.ts');
    expect(entries[0]?.contents).toBe('export const x = 1;');
  });

  it('WriteOverlay rejects an escape attempt from an allowed dir', () => {
    const overlay = new WriteOverlay(policy(), ROOT);
    const escapeAttempt = overlay.write(`${ROOT}/.cgao/escape.ts`, 'evil');
    expect(escapeAttempt.decision).toBe('POLICY_DENIED');
    // The denied write is NOT recorded as an entry.
    expect(overlay.entriesList().length).toBe(0);
    // ...but IS surfaced on the audit surface.
    expect(overlay.denied.length).toBe(1);
    expect(overlay.denied[0]?.path).toBe(`${ROOT}/.cgao/escape.ts`);
  });
});

/**
 * T-M5-006 clean checkout validation regression.
 *
 * Contracts (spec §12.6 / §13.3):
 *   - dirty workspace rejected (agent's tree has unexpected changes)
 *   - clean patch accepted
 *   - patch touching forbidden path rejected
 */

import { describe, expect, it } from 'vitest';
import { applyToCleanCheckout, detectDirtyWorkspace } from '../sandbox/clean-checkout-applier.js';
import { exportPatch } from '../sandbox/patch-exporter.js';
import type { OverlayEntry } from '../sandbox/write-overlay.js';

describe('T-M5-006 clean checkout validation', () => {
  it('accepts a clean patch that touches only allowed paths', () => {
    const base = new Map([['src/features/a.ts', 'old']]);
    const entries: OverlayEntry[] = [
      { path: 'src/features/a.ts', contents: 'new', deleted: false },
    ];
    const result = applyToCleanCheckout({
      baseSha: 'sha'.repeat(16),
      entries,
      base,
      allowedPaths: ['src/features/**'],
      forbiddenPaths: ['.cgao/**'],
    });
    expect(result.decision).toBe('applied');
    expect(result.result.get('src/features/a.ts')).toBe('new');
  });

  it('rejects a patch that touches a forbidden path', () => {
    const base = new Map([['.cgao/payload', 'x']]);
    const entries: OverlayEntry[] = [{ path: '.cgao/payload', contents: 'evil', deleted: false }];
    const result = applyToCleanCheckout({
      baseSha: 'sha'.repeat(16),
      entries,
      base,
      allowedPaths: ['src/features/**'],
      forbiddenPaths: ['.cgao/**'],
    });
    expect(result.decision).toBe('rejected');
    expect(result.reasons.join('\n')).toMatch(/forbidden/);
  });

  it('detects a dirty workspace (changes outside the patch)', () => {
    const base = new Map([
      ['src/a.ts', 'old'],
      ['README.md', 'base'],
    ]);
    const workingTree = new Map([
      ['src/a.ts', 'old'],
      ['README.md', 'TAMPERED'], // dirty change NOT in patch
    ]);
    const dirty = detectDirtyWorkspace(workingTree, base, ['src/a.ts']);
    expect(dirty).toBe(true);
  });

  it('exportPatch produces a unified-diff with the expected header', () => {
    const base = new Map([['src/a.ts', 'old']]);
    const entries: OverlayEntry[] = [{ path: 'src/a.ts', contents: 'new', deleted: false }];
    const patch = exportPatch(entries, base);
    expect(patch.changedFiles).toEqual(['src/a.ts']);
    expect(patch.text).toContain('diff --git a/src/a.ts b/src/a.ts');
    expect(patch.text).toContain('-old');
    expect(patch.text).toContain('+new');
  });
});

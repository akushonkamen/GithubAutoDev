/**
 * T-M11-002 ConflictResolver regression.
 *
 * Contracts (spec §5 / §12.6):
 *   - Non-overlapping changes merge cleanly.
 *   - Overlapping changes go to CONFLICTED state, never silently dropped.
 *   - Identical writes (idempotent) are NOT conflicts.
 */

import { describe, expect, it } from 'vitest';
import type { OverlayEntry } from '../sandbox/write-overlay.js';
import { detectConflicts } from '../worktree/conflict-resolver.js';

function entry(path: string, contents: string, deleted = false): OverlayEntry {
  return { path, contents, deleted };
}

function mapOf(
  taskId: string,
  entries: readonly OverlayEntry[],
): [string, Map<string, OverlayEntry>] {
  const m = new Map<string, OverlayEntry>();
  for (const e of entries) m.set(e.path, e);
  return [taskId, m];
}

describe('T-M11-002 ConflictResolver', () => {
  it('non-overlapping changes are clean', () => {
    const perTask = new Map([
      mapOf('t1', [entry('src/a.ts', 'a')]),
      mapOf('t2', [entry('src/b.ts', 'b')]),
    ]);
    const r = detectConflicts(perTask);
    expect(r.state).toBe('clean');
    expect(r.conflicts.length).toBe(0);
    expect(r.safePaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('overlapping modify/modify goes to CONFLICTED', () => {
    const perTask = new Map([
      mapOf('t1', [entry('src/a.ts', 'from-t1')]),
      mapOf('t2', [entry('src/a.ts', 'from-t2')]),
    ]);
    const r = detectConflicts(perTask);
    expect(r.state).toBe('CONFLICTED');
    expect(r.conflicts.length).toBe(1);
    expect(r.conflicts[0]?.path).toBe('src/a.ts');
    expect(r.conflicts[0]?.kind).toBe('modify_modify');
  });

  it('identical writes are NOT conflicts', () => {
    const perTask = new Map([
      mapOf('t1', [entry('src/a.ts', 'same')]),
      mapOf('t2', [entry('src/a.ts', 'same')]),
    ]);
    const r = detectConflicts(perTask);
    expect(r.state).toBe('clean');
    expect(r.safePaths).toContain('src/a.ts');
  });

  it('delete/modify goes to CONFLICTED', () => {
    const perTask = new Map([
      mapOf('t1', [entry('src/a.ts', '', true)]),
      mapOf('t2', [entry('src/a.ts', 'new')]),
    ]);
    const r = detectConflicts(perTask);
    expect(r.state).toBe('CONFLICTED');
    expect(r.conflicts[0]?.kind).toBe('delete_modify');
  });
});

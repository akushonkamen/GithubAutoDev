/**
 * Conflict resolver — T-M11-002, spec §5 / §12.6.
 *
 * Detects file-level conflicts between parallel task patches. Two
 * patches conflict when they touch the SAME path with different
 * contents (or one deletes a path the other modifies).
 *
 * Non-overlapping changes merge cleanly. Overlapping changes are
 * routed to CONFLICTED state — the test-fix-loop (M6) picks them up
 * rather than silently dropping a task's work.
 */

import type { OverlayEntry } from '../sandbox/write-overlay.js';

export type ConflictKind = 'modify_modify' | 'delete_modify' | 'delete_delete';

export interface ConflictRecord {
  path: string;
  kind: ConflictKind;
  /** Task ids that produced conflicting writes for this path. */
  taskIds: readonly string[];
}

export interface ConflictResolution {
  /** 'clean' when no conflicts; 'CONFLICTED' otherwise. */
  state: 'clean' | 'CONFLICTED';
  /** Conflicts (empty when state='clean'). */
  conflicts: readonly ConflictRecord[];
  /**
   * Paths that are safe to merge (no two tasks disagree). Caller can
   * fast-merge these without consulting the conflicts list.
   */
  safePaths: readonly string[];
}

/**
 * Detect conflicts across per-task entry maps. Each entry map is the
 * overlay contents a single task produced (path → entry).
 *
 * Algorithm: union all paths. For each path, gather the set of (task,
 * entry) tuples. If exactly one task wrote it → safe. If two tasks
 * wrote identical contents → safe (idempotent). Otherwise → conflict,
 * classified by the operation pair.
 */
export function detectConflicts(
  perTask: ReadonlyMap<string, ReadonlyMap<string, OverlayEntry>>,
): ConflictResolution {
  const byPath = new Map<string, Array<{ taskId: string; entry: OverlayEntry }>>();
  for (const [taskId, entries] of perTask.entries()) {
    for (const [path, entry] of entries.entries()) {
      const list = byPath.get(path) ?? [];
      list.push({ taskId, entry });
      byPath.set(path, list);
    }
  }

  const conflicts: ConflictRecord[] = [];
  const safePaths: string[] = [];

  for (const [path, writers] of byPath.entries()) {
    if (writers.length === 1) {
      safePaths.push(path);
      continue;
    }
    // Multiple writers: check whether contents are identical.
    const first = writers[0];
    if (!first) continue;
    const allSame = writers.every((w) => entriesEqual(w.entry, first.entry));
    if (allSame) {
      safePaths.push(path);
      continue;
    }
    // Conflict. Classify by operation pair.
    const ops = new Set(writers.map((w) => (w.entry.deleted ? 'delete' : 'modify')));
    let kind: ConflictKind;
    if (ops.has('delete') && ops.has('modify')) {
      kind = 'delete_modify';
    } else if (ops.has('delete')) {
      kind = 'delete_delete';
    } else {
      kind = 'modify_modify';
    }
    conflicts.push({
      path,
      kind,
      taskIds: writers.map((w) => w.taskId),
    });
  }

  return {
    state: conflicts.length === 0 ? 'clean' : 'CONFLICTED',
    conflicts: conflicts.sort((a, b) => a.path.localeCompare(b.path)),
    safePaths: safePaths.sort(),
  };
}

function entriesEqual(a: OverlayEntry, b: OverlayEntry): boolean {
  return a.deleted === b.deleted && a.contents === b.contents;
}

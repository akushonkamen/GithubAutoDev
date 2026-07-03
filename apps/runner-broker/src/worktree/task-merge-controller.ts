/**
 * Task merge controller — T-M11-002, spec §5 / §12.6.
 *
 * Merges per-task patch results back into the work branch in
 * dependency order and produces a single WorkerResultArtifact for
 * downstream gates (fast-gate, verifier, test-fix-loop).
 *
 * Dependency order is determined by the caller-supplied taskOrder:
 * tasks earlier in the list are applied first; later tasks see the
 * accumulated overlay. The controller does NOT re-resolve conflicts
 * during apply — ConflictResolver runs once, up-front, and any
 * conflict short-circuits the merge to CONFLICTED.
 *
 * When CONFLICTED, the controller still emits a WorkerResultArtifact
 * over the safePaths subset so downstream gates can run on the
 * conflict-free portion (the test-fix-loop picks up the conflicts
 * separately).
 */

import { createHash } from 'node:crypto';
import type { ExecutorTaskResult, WorkerResultArtifact } from '../dev/development-module.js';
import type { OverlayEntry } from '../sandbox/write-overlay.js';
import { type ConflictResolution, detectConflicts } from './conflict-resolver.js';

export interface TaskMergeInput {
  /** Per-task results, in dispatch order (NOT merge order). */
  results: readonly ExecutorTaskResult[];
  /**
   * Merge order — task ids in the order they should be applied. Must
   * be a permutation of results[*].taskId. Defaults to dispatch order.
   */
  taskOrder?: readonly string[];
}

export interface TaskMergeOutput {
  state: 'clean' | 'CONFLICTED';
  /** Conflict analysis (empty conflicts when state='clean'). */
  resolution: ConflictResolution;
  /** Merged overlay entries (path → entry), only safePaths included. */
  merged: ReadonlyMap<string, OverlayEntry>;
  /** Single WorkerResultArtifact for downstream gates. */
  artifact: WorkerResultArtifact;
  /** Failed tasks (status='failed'), in dispatch order. */
  failedTasks: readonly string[];
}

export class TaskMergeController {
  merge(input: TaskMergeInput): TaskMergeOutput {
    const order = input.taskOrder ?? input.results.map((r) => r.taskId);
    const byId = new Map(input.results.map((r) => [r.taskId, r]));

    // Per-task entry maps for conflict detection.
    const perTask = new Map<string, ReadonlyMap<string, OverlayEntry>>();
    for (const r of input.results) {
      const m = new Map<string, OverlayEntry>();
      for (const e of r.entries) {
        m.set(e.path, { path: e.path, contents: e.contents, deleted: e.deleted });
      }
      perTask.set(r.taskId, m);
    }
    const resolution = detectConflicts(perTask);
    const safePaths = new Set(resolution.safePaths);

    // Apply tasks in dependency order, keeping only safe paths.
    const merged = new Map<string, OverlayEntry>();
    for (const taskId of order) {
      const r = byId.get(taskId);
      if (!r) continue;
      for (const e of r.entries) {
        if (!safePaths.has(e.path)) continue;
        merged.set(e.path, { path: e.path, contents: e.contents, deleted: e.deleted });
      }
    }

    const changedFiles = [...merged.keys()].sort();
    const testsRun = input.results.flatMap((r) => r.testsRun);
    const failedTasks = input.results.filter((r) => r.status === 'failed').map((r) => r.taskId);

    // Deterministic patchSha over canonical merged representation.
    const canonicalParts: string[] = [];
    for (const path of changedFiles) {
      const e = merged.get(path);
      if (!e) continue;
      canonicalParts.push(`${e.deleted ? 'DEL' : 'MOD'}:${e.path}:${e.contents}`);
    }
    const patchSha = `sha256:${createHash('sha256')
      .update(canonicalParts.join('\n---\n'))
      .digest('hex')}`;

    const artifact: WorkerResultArtifact = {
      kind: 'worker_result',
      payload: {
        patchSha,
        changedFiles,
        testsRun,
      },
    };

    return {
      state: resolution.state,
      resolution,
      merged,
      artifact,
      failedTasks,
    };
  }
}

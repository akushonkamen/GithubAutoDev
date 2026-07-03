/**
 * T-M11-002 TaskMergeController regression.
 *
 * Contracts (spec §5 / §12.6):
 *   - Clean merge emits a single WorkerResultArtifact over merged entries.
 *   - Conflicts route to CONFLICTED state; safePaths still merged.
 *   - Merge order respects taskOrder when supplied.
 */

import { describe, expect, it } from 'vitest';
import type { ExecutorTaskResult } from '../dev/development-module.js';
import { TaskMergeController } from '../worktree/task-merge-controller.js';

function task(taskId: string, paths: Record<string, string>): ExecutorTaskResult {
  return {
    taskId,
    status: 'completed',
    entries: Object.entries(paths).map(([path, contents]) => ({
      path,
      contents,
      deleted: false,
    })),
    testsRun: [],
  };
}

describe('T-M11-002 TaskMergeController', () => {
  it('clean merge produces single worker_result over merged entries', () => {
    const ctrl = new TaskMergeController();
    const out = ctrl.merge({
      results: [task('t1', { 'src/a.ts': 'a' }), task('t2', { 'src/b.ts': 'b' })],
    });
    expect(out.state).toBe('clean');
    expect(out.artifact.kind).toBe('worker_result');
    expect(out.artifact.payload.changedFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(out.artifact.payload.patchSha).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('conflicts route to CONFLICTED; safePaths still merged', () => {
    const ctrl = new TaskMergeController();
    const out = ctrl.merge({
      results: [
        task('t1', { 'src/a.ts': 'a-from-t1', 'src/c.ts': 'c' }),
        task('t2', { 'src/a.ts': 'a-from-t2', 'src/d.ts': 'd' }),
      ],
    });
    expect(out.state).toBe('CONFLICTED');
    expect(out.resolution.conflicts.map((c) => c.path)).toEqual(['src/a.ts']);
    expect(out.merged.has('src/a.ts')).toBe(false);
    expect(out.merged.has('src/c.ts')).toBe(true);
    expect(out.merged.has('src/d.ts')).toBe(true);
  });

  it('respects taskOrder for merge application', () => {
    const ctrl = new TaskMergeController();
    const out = ctrl.merge({
      results: [task('t1', { 'src/a.ts': 'a' }), task('t2', { 'src/b.ts': 'b' })],
      taskOrder: ['t2', 't1'],
    });
    const mergedPaths = [...out.merged.keys()].sort();
    expect(mergedPaths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('records failed tasks', () => {
    const ctrl = new TaskMergeController();
    const out = ctrl.merge({
      results: [
        { ...task('t1', { 'src/a.ts': 'a' }), status: 'failed' },
        task('t2', { 'src/b.ts': 'b' }),
      ],
    });
    expect(out.failedTasks).toEqual(['t1']);
  });
});

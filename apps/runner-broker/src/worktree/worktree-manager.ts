/**
 * Worktree manager — T-M11-002, spec §5 / §12.6.
 *
 * Allocates N isolated worktrees for parallel task execution. Each
 * worktree shares the read-only base (defined by defineReadOnlyBase)
 * but owns its own WriteOverlay so parallel tasks never observe each
 * other's in-flight writes.
 *
 * M11 ships an in-memory representation: a Worktree is a logical
 * (base, overlay) pair identified by a stable id. The git `worktree
 * add` plumbing lands when the runner-broker dispatches real
 * subprocesses; the contracts here are what the test/merge controller
 * and conflict resolver consume.
 */

import { PathWritePolicy } from '../sandbox/path-write-policy.js';
import { type ReadOnlyBase, defineReadOnlyBase } from '../sandbox/read-only-base.js';
import { WriteOverlay } from '../sandbox/write-overlay.js';

export interface Worktree {
  /** Stable id (e.g. `wt-<runId>-<taskId>`). */
  id: string;
  /** Task id this worktree runs. */
  taskId: string;
  /** Read-only base shared across all worktrees for the same run. */
  base: ReadOnlyBase;
  /** Per-worktree overlay. Writes here are NOT visible to siblings. */
  overlay: WriteOverlay;
}

export interface AllocateInput {
  /** Repo full name (e.g. 'owner/repo'). */
  repo: string;
  /** Base SHA all tasks branch from. */
  baseSha: string;
  /** Files present at baseSha (relative paths). */
  baseFiles: readonly string[];
  /** Workspace root path. */
  workspaceRoot: string;
  /** Task specs to allocate worktrees for. */
  tasks: ReadonlyArray<{
    id: string;
    allowedPaths: readonly string[];
    forbiddenPaths: readonly string[];
  }>;
  /** Run id used to namespace worktree ids. */
  runId: string;
}

export interface AllocateResult {
  worktrees: readonly Worktree[];
}

export class WorktreeManager {
  allocate(input: AllocateInput): AllocateResult {
    const base = defineReadOnlyBase(input.workspaceRoot, input.baseSha, input.baseFiles);
    const worktrees: Worktree[] = input.tasks.map((task) => {
      const policy = new PathWritePolicy({
        workspaceRoot: input.workspaceRoot,
        allowedPaths: task.allowedPaths,
        forbiddenPaths: task.forbiddenPaths,
      });
      const overlay = new WriteOverlay(policy, input.workspaceRoot);
      return {
        id: `wt-${input.runId}-${task.id}`,
        taskId: task.id,
        base,
        overlay,
      };
    });
    return { worktrees };
  }
}

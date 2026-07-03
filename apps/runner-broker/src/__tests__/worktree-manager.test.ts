/**
 * T-M11-002 WorktreeManager regression.
 *
 * Contracts (spec §5 / §12.6):
 *   - 2+ tasks run in parallel against separate worktrees.
 *   - Each worktree has its own WriteOverlay (no shared mutable state).
 *   - Reads from the shared read-only base are identical.
 */

import { describe, expect, it } from 'vitest';
import { WorktreeManager } from '../worktree/worktree-manager.js';

describe('T-M11-002 WorktreeManager', () => {
  it('allocates one isolated worktree per task', () => {
    const mgr = new WorktreeManager();
    const { worktrees } = mgr.allocate({
      repo: 'owner/repo',
      baseSha: 'a'.repeat(40),
      baseFiles: ['src/index.ts', 'README.md'],
      workspaceRoot: '/repo',
      runId: 'run-1',
      tasks: [
        { id: 't1', allowedPaths: ['src/a/**'], forbiddenPaths: ['.cgao/**'] },
        { id: 't2', allowedPaths: ['src/b/**'], forbiddenPaths: ['.cgao/**'] },
      ],
    });
    expect(worktrees.length).toBe(2);
    expect(worktrees[0]?.id).toBe('wt-run-1-t1');
    expect(worktrees[1]?.id).toBe('wt-run-1-t2');
  });

  it('parallel worktrees do not share mutable overlay state', () => {
    const mgr = new WorktreeManager();
    const { worktrees } = mgr.allocate({
      repo: 'owner/repo',
      baseSha: 'a'.repeat(40),
      baseFiles: ['src/index.ts'],
      workspaceRoot: '/repo',
      runId: 'run-1',
      tasks: [
        { id: 't1', allowedPaths: ['src/a/**'], forbiddenPaths: [] },
        { id: 't2', allowedPaths: ['src/b/**'], forbiddenPaths: [] },
      ],
    });
    const [wt1, wt2] = worktrees;
    wt1?.overlay.write('/repo/src/a/file.ts', 'from-t1');
    expect(wt1?.overlay.isEmpty).toBe(false);
    expect(wt2?.overlay.isEmpty).toBe(true);
  });

  it('shares the read-only base across all worktrees', () => {
    const mgr = new WorktreeManager();
    const { worktrees } = mgr.allocate({
      repo: 'owner/repo',
      baseSha: 'b'.repeat(40),
      baseFiles: ['base.txt'],
      workspaceRoot: '/repo',
      runId: 'run-1',
      tasks: [
        { id: 't1', allowedPaths: ['**'], forbiddenPaths: [] },
        { id: 't2', allowedPaths: ['**'], forbiddenPaths: [] },
      ],
    });
    const base1 = worktrees[0]?.base;
    const base2 = worktrees[1]?.base;
    expect(base1?.baseSha).toBe(base2?.baseSha);
    expect(base1?.files).toEqual(base2?.files);
  });
});

/**
 * WorkflowRunRepository regression — T-M2-002, spec §9 / §15.
 *
 * Locks two properties:
 *  - optimistic version check rejects stale writes
 *  - per-run advisory lock serializes concurrent transitions
 *  - duplicate create() / duplicate PR creation under racing events
 *    is impossible because the lock holder sees a single timeline
 */

import { describe, expect, it } from 'vitest';
import {
  ConcurrentUpdateError,
  InMemoryWorkflowRunRepository,
  RunNotFoundError,
} from '../../repos/workflow-run-repo.js';

describe('InMemoryWorkflowRunRepository (T-M2-002)', () => {
  it('create + findById round-trip', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    const run = await repo.create({
      id: 'run_a',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 1,
      state: 'intake',
    });
    expect(run.version).toBe(0);
    expect(run.riskLevel).toBe('unknown');
    expect((await repo.findById('run_a'))?.id).toBe('run_a');
  });

  it('update with stale expectedVersion throws ConcurrentUpdateError', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await repo.create({
      id: 'run_b',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 2,
      state: 'intake',
    });
    await repo.update('run_b', 0, { state: 'planning' });
    await expect(repo.update('run_b', 0, { state: 'reviewing' })).rejects.toBeInstanceOf(
      ConcurrentUpdateError,
    );
    const final = await repo.findById('run_b');
    expect(final?.version).toBe(1);
    expect(final?.state).toBe('planning');
  });

  it('update on missing run throws RunNotFoundError', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await expect(repo.update('missing', 0, { state: 'x' })).rejects.toBeInstanceOf(
      RunNotFoundError,
    );
  });

  it('per-run lock serializes concurrent transitions', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await repo.create({
      id: 'run_c',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 3,
      state: 'intake',
    });

    const events = ['e1', 'e2', 'e3'].map((id) =>
      (async () => {
        return repo.withLock('run_c', id, async () => {
          const current = await repo.findById('run_c');
          if (!current) throw new Error('missing');
          return repo.update('run_c', current.version, {
            state: `${current.state}+${id}`,
          });
        });
      })(),
    );
    const results = await Promise.all(events);
    expect(results.map((r) => r.version)).toEqual([1, 2, 3]);
    const final = await repo.findById('run_c');
    expect(final?.state).toBe('intake+e1+e2+e3');
  });

  it('listByIssue only returns matching rows', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await repo.create({
      id: 'run_d',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 42,
      state: 'intake',
    });
    await repo.create({
      id: 'run_e',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 43,
      state: 'intake',
    });
    const list = await repo.listByIssue('cgao', 'test', 42);
    expect(list.map((r) => r.id)).toEqual(['run_d']);
  });

  it('bumpUpdatedAt increments version without changing fields', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await repo.create({
      id: 'run_f',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 1,
      state: 'intake',
    });
    const after = await repo.bumpUpdatedAt('run_f', 0);
    expect(after.version).toBe(1);
    expect(after.state).toBe('intake');
  });

  it('duplicate create with same id throws ConcurrentUpdateError', async () => {
    const repo = new InMemoryWorkflowRunRepository();
    await repo.create({
      id: 'run_dup',
      repoOwner: 'cgao',
      repoName: 'test',
      issueNumber: 1,
      state: 'intake',
    });
    await expect(
      repo.create({
        id: 'run_dup',
        repoOwner: 'cgao',
        repoName: 'test',
        issueNumber: 1,
        state: 'intake',
      }),
    ).rejects.toBeInstanceOf(ConcurrentUpdateError);
  });
});

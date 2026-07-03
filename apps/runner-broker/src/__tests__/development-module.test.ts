/**
 * T-M5-008 development module main flow regression.
 *
 * Contracts (spec §12.6):
 *   - happy path: all tasks complete → worker_result artifact, status='completed'
 *   - failed executor task → dev.failed or fix.requested
 */

import { describe, expect, it } from 'vitest';
import {
  type DevHandoff,
  type DevPlan,
  type ExecutorTaskResult,
  InMemoryPatchAggregator,
  runDevTask,
} from '../dev/development-module.js';
import { CredentialProfile } from '../profiles/credential-profile.js';

type DispatchArgs = { taskId: string; plan: DevPlan; profile: CredentialProfile };

function makePlan(): DevPlan {
  return {
    planId: 'plan-0001',
    planSha: 'a'.repeat(64),
    tasks: [
      { id: 't1', allowedPaths: ['src/features/**'], forbiddenPaths: ['.cgao/**'] },
      { id: 't2', allowedPaths: ['src/features/**'], forbiddenPaths: ['.cgao/**'] },
    ],
  };
}

function makeHandoff(): DevHandoff {
  return {
    kind: 'plan_to_dev',
    planId: 'plan-0001',
    planSha: 'a'.repeat(64),
    taskIds: ['t1', 't2'],
    allowedPaths: ['src/features/**'],
    forbiddenPaths: ['.cgao/**'],
  };
}

describe('T-M5-008 runDevTask happy path', () => {
  it('aggregates patches and emits a worker_result artifact', async () => {
    const plan = makePlan();
    const handoff = makeHandoff();
    const dispatch = async (): Promise<ExecutorTaskResult> => ({
      taskId: 't1',
      status: 'completed',
      entries: [{ path: 'src/features/a.ts', contents: 'new', deleted: false }],
      testsRun: [{ command: 'pnpm test', exitCode: 0 }],
    });
    const auditCalls: { kind: string; payload: unknown }[] = [];
    const result = await runDevTask({
      plan,
      taskIds: ['t1', 't2'],
      handoff,
      dispatch,
      audit: {
        append: async (input) => {
          auditCalls.push(input);
        },
      },
    });
    expect(result.status).toBe('completed');
    expect(result.artifact.kind).toBe('worker_result');
    expect(result.artifact.payload.changedFiles).toContain('src/features/a.ts');
    expect(result.artifact.payload.testsRun.length).toBe(2);
    expect(result.artifact.payload.patchSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(auditCalls.length).toBe(0);
  });

  it('uses the untrusted code runner profile for every dispatch', async () => {
    const plan = makePlan();
    const handoff = makeHandoff();
    const seen: CredentialProfile[] = [];
    const dispatch = async (args: DispatchArgs): Promise<ExecutorTaskResult> => {
      seen.push(args.profile);
      return {
        taskId: args.taskId,
        status: 'completed',
        entries: [],
        testsRun: [],
      };
    };
    await runDevTask({
      plan,
      taskIds: ['t1', 't2'],
      handoff,
      dispatch,
      audit: { append: async () => {} },
    });
    expect(seen.every((p) => p === CredentialProfile.UNTRUSTED_CODE)).toBe(true);
  });
});

describe('T-M5-008 runDevTask failure path', () => {
  it('emits fix.requested when an executor task fails with a test failure', async () => {
    const plan = makePlan();
    const handoff = makeHandoff();
    const dispatch = async (args: DispatchArgs): Promise<ExecutorTaskResult> => {
      if (args.taskId === 't2') {
        return {
          taskId: 't2',
          status: 'failed',
          entries: [],
          error: 'tests failed',
          testsRun: [{ command: 'pnpm test', exitCode: 1 }],
        };
      }
      return {
        taskId: args.taskId,
        status: 'completed',
        entries: [{ path: 'src/features/a.ts', contents: 'new', deleted: false }],
        testsRun: [{ command: 'pnpm test', exitCode: 0 }],
      };
    };
    const auditCalls: { kind: string; payload: Record<string, unknown> }[] = [];
    const result = await runDevTask({
      plan,
      taskIds: ['t1', 't2'],
      handoff,
      dispatch,
      audit: {
        append: async (input) => {
          auditCalls.push({ kind: input.kind, payload: input.payload });
        },
      },
    });
    expect(result.status).toBe('fix.requested');
    expect(auditCalls.length).toBe(1);
    expect(auditCalls[0]?.kind).toBe('fix.requested');
    expect(auditCalls[0]?.payload.failedTasks).toEqual(['t2']);
  });

  it('emits dev.failed when an executor crashes (no test signal)', async () => {
    const plan = makePlan();
    const handoff = makeHandoff();
    const dispatch = async (args: DispatchArgs): Promise<ExecutorTaskResult> => {
      if (args.taskId === 't1') {
        return {
          taskId: 't1',
          status: 'failed',
          entries: [],
          error: 'segfault',
          testsRun: [],
        };
      }
      return {
        taskId: args.taskId,
        status: 'completed',
        entries: [],
        testsRun: [],
      };
    };
    const auditCalls: { kind: string }[] = [];
    const result = await runDevTask({
      plan,
      taskIds: ['t1', 't2'],
      handoff,
      dispatch,
      audit: {
        append: async (input) => {
          auditCalls.push({ kind: input.kind });
        },
      },
    });
    expect(result.status).toBe('dev.failed');
    expect(auditCalls[0]?.kind).toBe('dev.failed');
  });

  it('PatchAggregator collects results in order', () => {
    const agg = new InMemoryPatchAggregator();
    agg.add({ taskId: 't1', status: 'completed', entries: [], testsRun: [] });
    agg.add({ taskId: 't2', status: 'completed', entries: [], testsRun: [] });
    expect(agg.all().map((r) => r.taskId)).toEqual(['t1', 't2']);
  });
});

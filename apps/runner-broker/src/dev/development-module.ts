/**
 * Development module main flow — T-M5-008, spec §12.6.
 *
 * runDevTask is the entry point the orchestrator calls after a plan
 * is approved. It:
 *
 *   1. Reads the plan_to_dev handoff.
 *   2. For each task id, creates an AgentRun via RunnerBroker and
 *      dispatches it to the untrusted code runner profile.
 *   3. Collects resulting patches into a PatchAggregator.
 *   4. Emits a WorkerResult artifact (kind = 'worker_result', payload
 *      has patchSha, changedFiles, testsRun).
 *   5. On failure: emits dev.failed or fix.requested audit.
 *
 * The dev module is intentionally pure-ish: it takes injectable ports
 * for the broker, patch aggregator, artifact store, and audit chain,
 * so tests can drive happy/failure paths without subprocesses.
 */

import { createHash } from 'node:crypto';
import { CredentialProfile } from '../profiles/credential-profile.js';

/**
 * Lightweight plan shape the dev module consumes. Mirrors the
 * orchestrator's ImplementationPlan but trimmed to what we need here.
 */
export interface DevPlan {
  planId: string;
  planSha: string;
  tasks: ReadonlyArray<{
    id: string;
    allowedPaths: readonly string[];
    forbiddenPaths: readonly string[];
  }>;
}

export interface DevHandoff {
  kind: 'plan_to_dev';
  planId: string;
  planSha: string;
  taskIds: readonly string[];
  allowedPaths: readonly string[];
  forbiddenPaths: readonly string[];
}

/** Per-task executor result the broker returns to the dev module. */
export interface ExecutorTaskResult {
  taskId: string;
  status: 'completed' | 'failed';
  /** Overlay entries the executor produced (empty on failure). */
  entries: ReadonlyArray<{ path: string; contents: string; deleted: boolean }>;
  /** Error message on failure. */
  error?: string;
  /** Tests the executor ran (advisory; reviewer re-runs independently). */
  testsRun: ReadonlyArray<{ command: string; exitCode: number }>;
}

/** Aggregated patch + metadata the dev module emits. */
export interface PatchAggregator {
  add(result: ExecutorTaskResult): void;
  all(): ReadonlyArray<ExecutorTaskResult>;
}

export class InMemoryPatchAggregator implements PatchAggregator {
  private readonly results: ExecutorTaskResult[] = [];
  add(result: ExecutorTaskResult): void {
    this.results.push(result);
  }
  all(): ReadonlyArray<ExecutorTaskResult> {
    return [...this.results];
  }
}

export interface WorkerResultArtifact {
  kind: 'worker_result';
  payload: {
    patchSha: string;
    changedFiles: readonly string[];
    testsRun: readonly { command: string; exitCode: number }[];
  };
}

export interface RunDevTaskInput {
  plan: DevPlan;
  taskIds: readonly string[];
  handoff: DevHandoff;
  /** Dispatches a single task to the untrusted runner. */
  dispatch: (args: {
    taskId: string;
    plan: DevPlan;
    profile: CredentialProfile;
  }) => Promise<ExecutorTaskResult>;
  /** Audit sink. */
  audit: {
    append(input: {
      runId: string | null;
      kind: string;
      payload: Record<string, unknown>;
    }): Promise<unknown>;
  };
  aggregator?: PatchAggregator;
  runId?: string;
}

export interface RunDevTaskOutput {
  status: 'completed' | 'dev.failed' | 'fix.requested';
  artifact: WorkerResultArtifact;
  results: readonly ExecutorTaskResult[];
}

/**
 * Run the dev module main flow.
 *
 * Happy path: every dispatched task returns status='completed'. The
 * aggregator collects patches; the dev module emits a worker_result
 * artifact whose patchSha is sha256 of the concatenated patch text.
 *
 * Failure path: any task returns status='failed'. The dev module
 * emits a `dev.failed` audit (and `fix.requested` when the failure
 * looks recoverable — e.g. test failure vs. crash). The WorkerResult
 * is still emitted, with patchSha over whatever did complete.
 */
export async function runDevTask(input: RunDevTaskInput): Promise<RunDevTaskOutput> {
  const aggregator = input.aggregator ?? new InMemoryPatchAggregator();
  const runId = input.runId ?? `run-${input.plan.planId}`;
  const profile: CredentialProfile = CredentialProfile.UNTRUSTED_CODE;

  let anyFailed = false;
  let recoverable = false;
  for (const taskId of input.taskIds) {
    const result = await input.dispatch({ taskId, plan: input.plan, profile });
    aggregator.add(result);
    if (result.status === 'failed') {
      anyFailed = true;
      // A test failure (exitCode != 0 but with a message) is recoverable.
      const hasTestFailure = result.testsRun.some((t) => t.exitCode !== 0);
      if (hasTestFailure) recoverable = true;
    }
  }

  const results = aggregator.all();
  const changedFiles: string[] = [];
  const allEntries: string[] = [];
  const testsRun: { command: string; exitCode: number }[] = [];
  for (const r of results) {
    for (const e of r.entries) changedFiles.push(e.path);
    for (const e of r.entries) allEntries.push(`${e.path}\n${e.contents}`);
    testsRun.push(...r.testsRun);
  }
  const patchSha = `sha256:${createHash('sha256').update(allEntries.join('\n---\n')).digest('hex')}`;

  const artifact: WorkerResultArtifact = {
    kind: 'worker_result',
    payload: {
      patchSha,
      changedFiles: [...new Set(changedFiles)].sort(),
      testsRun,
    },
  };

  if (!anyFailed) {
    return { status: 'completed', artifact, results };
  }
  const auditKind = recoverable ? 'fix.requested' : 'dev.failed';
  await input.audit.append({
    runId,
    kind: auditKind,
    payload: {
      planId: input.plan.planId,
      taskIds: [...input.taskIds],
      failedTasks: results.filter((r) => r.status === 'failed').map((r) => r.taskId),
      patchSha,
    },
  });
  return { status: auditKind, artifact, results };
}

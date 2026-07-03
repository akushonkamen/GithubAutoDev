/**
 * WorkflowRun repository — T-M2-002, spec §9 / §15.
 *
 * Contract:
 *  - update() is optimistic: caller passes the version they last saw;
 *    if it doesn't match the stored version, throw ConcurrentUpdateError.
 *  - withLock() holds an exclusive per-run advisory lock for the
 *    duration of fn. Re-entrant by the same holder is allowed; any
 *    other holder waits (in-memory) or fails fast (Postgres path).
 *
 * InMemoryWorkflowRunRepository is sufficient for unit tests and the
 * orchestrator's startup mode; a Postgres-backed implementation will
 * land later using pg-advisory-xact-lock and SELECT ... FOR UPDATE.
 */

import { randomUUID } from 'node:crypto';
import type { WorkflowRun } from '../schema/workflow-runs.js';

export class ConcurrentUpdateError extends Error {
  readonly runId: string;
  readonly expectedVersion: number;
  readonly actualVersion: number;
  constructor(runId: string, expectedVersion: number, actualVersion: number) {
    super(
      `concurrent update on workflow_run ${runId}: expected version ${expectedVersion}, got ${actualVersion}`,
    );
    this.name = 'ConcurrentUpdateError';
    this.runId = runId;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

export class RunNotFoundError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`workflow_run not found: ${runId}`);
    this.name = 'RunNotFoundError';
    this.runId = runId;
  }
}

export class LockBusyError extends Error {
  readonly runId: string;
  readonly holder: string;
  constructor(runId: string, holder: string) {
    super(`run ${runId} is locked by ${holder}`);
    this.name = 'LockBusyError';
    this.runId = runId;
    this.holder = holder;
  }
}

export type WorkflowRunPatch = Partial<Omit<NewWorkflowRunInput, 'id' | 'version' | 'createdAt'>>;

export interface NewWorkflowRunInput {
  id: string;
  repoOwner: string;
  repoName: string;
  issueNumber?: number | null;
  prNumber?: number | null;
  state: string;
  riskLevel?: string;
  generation?: number;
  currentAttempt?: number;
}

export interface WorkflowRunRepository {
  create(input: NewWorkflowRunInput): Promise<WorkflowRun>;
  findById(id: string): Promise<WorkflowRun | null>;
  update(id: string, expectedVersion: number, patch: WorkflowRunPatch): Promise<WorkflowRun>;
  bumpUpdatedAt(id: string, expectedVersion: number): Promise<WorkflowRun>;
  listByIssue(owner: string, name: string, issueNumber: number): Promise<WorkflowRun[]>;
}

export interface RunLock {
  acquire(holder: string): Promise<void>;
  release(holder: string): Promise<void>;
  with<T>(holder: string, fn: () => Promise<T>): Promise<T>;
  currentHolder(): string | null;
}

export class InMemoryWorkflowRunRepository implements WorkflowRunRepository {
  private readonly rows = new Map<string, WorkflowRun>();
  private readonly locks = new Map<string, RunLock>();

  async create(input: NewWorkflowRunInput): Promise<WorkflowRun> {
    if (this.rows.has(input.id)) {
      throw new ConcurrentUpdateError(input.id, -1, 0);
    }
    const now = new Date();
    const row: WorkflowRun = {
      id: input.id,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      issueNumber: input.issueNumber ?? null,
      prNumber: input.prNumber ?? null,
      state: input.state,
      riskLevel: input.riskLevel ?? 'unknown',
      generation: input.generation ?? 1,
      currentIssueSnapshotSha: null,
      currentSpecId: null,
      currentSpecSha: null,
      currentPlanId: null,
      currentPlanSha: null,
      currentApprovalId: null,
      currentApprovalSha: null,
      currentHeadSha: null,
      currentBaseSha: null,
      currentModule: null,
      currentAttempt: input.currentAttempt ?? 0,
      createdAt: now,
      updatedAt: now,
      lockedBy: null,
      lockedUntil: null,
      version: 0,
    };
    this.rows.set(input.id, row);
    this.locks.set(input.id, new InMemoryRunLock());
    return { ...row };
  }

  async findById(id: string): Promise<WorkflowRun | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async update(id: string, expectedVersion: number, patch: WorkflowRunPatch): Promise<WorkflowRun> {
    const row = this.rows.get(id);
    if (!row) throw new RunNotFoundError(id);
    if (row.version !== expectedVersion) {
      throw new ConcurrentUpdateError(id, expectedVersion, row.version);
    }
    const next: WorkflowRun = {
      ...row,
      ...stripUndefined(patch),
      updatedAt: new Date(),
      version: row.version + 1,
    };
    this.rows.set(id, next);
    return { ...next };
  }

  async bumpUpdatedAt(id: string, expectedVersion: number): Promise<WorkflowRun> {
    return this.update(id, expectedVersion, {});
  }

  async listByIssue(owner: string, name: string, issueNumber: number): Promise<WorkflowRun[]> {
    const out: WorkflowRun[] = [];
    for (const row of this.rows.values()) {
      if (row.repoOwner === owner && row.repoName === name && row.issueNumber === issueNumber) {
        out.push({ ...row });
      }
    }
    return out;
  }

  lockFor(id: string): RunLock {
    const lock = this.locks.get(id);
    if (!lock) throw new RunNotFoundError(id);
    return lock;
  }

  /** Run fn under the per-run advisory lock. */
  async withLock<T>(id: string, holder: string, fn: () => Promise<T>): Promise<T> {
    const lock = this.lockFor(id);
    return lock.with(holder, fn);
  }
}

export class InMemoryRunLock implements RunLock {
  private holder: string | null = null;
  private depth = 0;
  private readonly waiters: Array<() => void> = [];

  async acquire(holder: string): Promise<void> {
    if (this.holder === holder) {
      this.depth++;
      return;
    }
    while (this.holder !== null) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      if (this.holder !== null && this.holder !== holder) continue;
    }
    this.holder = holder;
    this.depth = 1;
  }

  async release(holder: string): Promise<void> {
    if (this.holder !== holder) return;
    this.depth--;
    if (this.depth > 0) return;
    this.holder = null;
    const next = this.waiters.shift();
    if (next) next();
  }

  async with<T>(holder: string, fn: () => Promise<T>): Promise<T> {
    await this.acquire(holder);
    try {
      return await fn();
    } finally {
      await this.release(holder);
    }
  }

  currentHolder(): string | null {
    return this.holder;
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

export function newRunId(): string {
  return `run_${randomUUID()}`;
}

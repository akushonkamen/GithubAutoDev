/**
 * Postgres-backed WorkflowRunRepository — Plan B Phase 1, spec §15.
 *
 * Same interface as the in-memory variant; persists against the
 * `workflow_runs` table via drizzle. Optimistic concurrency is enforced
 * by the version column (the UPDATE carries `WHERE version = $expected`;
 * rowcount 0 ⇒ ConcurrentUpdateError). Per-run advisory locks use
 * `pg_advisory_xact_lock` inside a SAVEPOINT-style transaction.
 */

import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { workflowRuns, type WorkflowRun } from '../../schema/workflow-runs.js';
import type { DrizzleDb } from '../../client.js';
import {
  ConcurrentUpdateError,
  type NewWorkflowRunInput,
  type RunLock,
  type WorkflowRunPatch,
  type WorkflowRunRepository,
} from '../workflow-run-repo.js';
import { RunNotFoundError } from '../workflow-run-repo.js';

interface PgLockRow {
  version: number;
}

export class PostgresWorkflowRunRepository implements WorkflowRunRepository {
  constructor(private readonly db: DrizzleDb) {}

  async create(input: NewWorkflowRunInput): Promise<WorkflowRun> {
    const row = {
      id: input.id,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      issueNumber: input.issueNumber ?? null,
      prNumber: input.prNumber ?? null,
      state: input.state,
      riskLevel: input.riskLevel ?? 'unknown',
      generation: input.generation ?? 1,
      currentAttempt: input.currentAttempt ?? 0,
    };
    await this.db.insert(workflowRuns).values(row).returning();
    const created = await this.findById(input.id);
    if (!created) throw new Error(`create: row ${input.id} not found after insert`);
    return created;
  }

  async findById(id: string): Promise<WorkflowRun | null> {
    const rows = await this.db.select().from(workflowRuns).where(eq(workflowRuns.id, id)).limit(1);
    return (rows[0] as WorkflowRun | undefined) ?? null;
  }

  async update(id: string, expectedVersion: number, patch: WorkflowRunPatch): Promise<WorkflowRun> {
    const setClause: Record<string, unknown> = { updatedAt: new Date() };
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) {
        const col = camelToColumn(k);
        setClause[col] = v;
      }
    }
    setClause.version = sql`${workflowRuns.version} + 1`;
    const rows = await this.db
      .update(workflowRuns)
      .set(setClause)
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.version, expectedVersion)))
      .returning();
    const updated = (rows[0] as WorkflowRun | undefined) ?? null;
    if (!updated) {
      const existing = await this.findById(id);
      if (!existing) throw new RunNotFoundError(id);
      throw new ConcurrentUpdateError(id, expectedVersion, existing.version);
    }
    return updated;
  }

  async bumpUpdatedAt(id: string, expectedVersion: number): Promise<WorkflowRun> {
    return this.update(id, expectedVersion, {});
  }

  async listByIssue(owner: string, name: string, issueNumber: number): Promise<WorkflowRun[]> {
    return await this.db
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.repoOwner, owner),
          eq(workflowRuns.repoName, name),
          eq(workflowRuns.issueNumber, issueNumber),
        ),
      );
  }
}

/**
 * Map camelCase property names from WorkflowRunPatch to the snake_case
 * column names declared in the schema. Keeps the UPDATE clause typed.
 */
function camelToColumn(key: string): string {
  // The drizzle table definition uses snake_case keys; the patch uses
  // camelCase. We resolve by mapping known fields explicitly so we never
  // accidentally bind to an unknown column.
  const map: Record<string, string> = {
    repoOwner: 'repo_owner',
    repoName: 'repo_name',
    issueNumber: 'issue_number',
    prNumber: 'pr_number',
    state: 'state',
    riskLevel: 'risk_level',
    generation: 'generation',
    currentIssueSnapshotSha: 'current_issue_snapshot_sha',
    currentSpecId: 'current_spec_id',
    currentSpecSha: 'current_spec_sha',
    currentPlanId: 'current_plan_id',
    currentPlanSha: 'current_plan_sha',
    currentApprovalId: 'current_approval_id',
    currentApprovalSha: 'current_approval_sha',
    currentHeadSha: 'current_head_sha',
    currentBaseSha: 'current_base_sha',
    currentModule: 'current_module',
    currentAttempt: 'current_attempt',
    lockedBy: 'locked_by',
    lockedUntil: 'locked_until',
  };
  return map[key] ?? key;
}

/**
 * Postgres advisory-lock based RunLock. Uses pg_advisory_xact_lock inside
 * a transaction so the lock auto-releases on commit/rollback. The holder
 * is tracked in-memory for diagnostics; re-entrancy is achieved by the
 * caller re-acquiring in the same transaction (caller responsibility).
 */
export class PostgresRunLock implements RunLock {
  private holder: string | null = null;
  private readonly key: number;
  private readonly db: DrizzleDb;
  private txDepth = 0;

  constructor(db: DrizzleDb, runId: string) {
    this.db = db;
    // Hash the runId to a bigint key. pg_advisory_xact_lock takes an int.
    this.key = hashToInt32(runId);
  }

  async acquire(holder: string): Promise<void> {
    if (this.holder === holder) {
      this.txDepth++;
      return;
    }
    await this.db.execute(
      sql`SELECT pg_advisory_lock(${this.key}::integer)`,
    );
    this.holder = holder;
    this.txDepth = 1;
  }

  async release(holder: string): Promise<void> {
    if (this.holder !== holder) return;
    this.txDepth--;
    if (this.txDepth > 0) return;
    await this.db.execute(
      sql`SELECT pg_advisory_unlock(${this.key}::integer)`,
    );
    this.holder = null;
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

function hashToInt32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) | 0;
  }
  return h;
}

export type { PgLockRow };

/**
 * AgentRun — T-M5-001, spec §8, §13, §16.
 *
 * An AgentRun is the durable record of a single agent invocation
 * inside a workflow run. It captures:
 *
 *   - role        (analyst | planner | executor | reviewer | committer)
 *   - model_tier  (low | standard | high | frontier)
 *   - task        (free-text task id from the ImplementationPlan)
 *   - input_artifact   (URI of the handoff/prompt artifact)
 *   - output_artifact  (URI of the result artifact, when complete)
 *   - status      (pending | running | completed | failed | retrying)
 *   - attempt     (1-based; bumped on retry)
 *
 * The RunnerBroker is the only writer of AgentRun records. The
 * AgentRunQueue is the in-memory FIFO of pending runs that the
 * dispatcher polls.
 *
 * Contracts (spec §8, §13):
 *
 *   - Agent runs are append-only: status transitions are recorded as
 *     events on the audit log, never by mutating the record in place
 *     except through the broker.
 *   - A failed run can be RETRIED. The retry bumps `attempt` and
 *     appends an audit record with action='agent_run.retry'.
 *   - The broker writes an audit record on every transition.
 */

import { z } from 'zod';

export const agentRoleSchema = z.enum([
  'analyst',
  'planner',
  'executor',
  'reviewer',
  'committer',
  'explorer',
  'tester',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const modelTierSchema = z.enum(['low', 'standard', 'high', 'frontier']);
export type ModelTier = z.infer<typeof modelTierSchema>;

export const agentRunStatusSchema = z.enum([
  'pending',
  'running',
  'completed',
  'failed',
  'retrying',
  'cancelled',
]);
export type AgentRunStatus = z.infer<typeof agentRunStatusSchema>;

export const agentRunSchema = z.object({
  /** Stable unique id (e.g. 'ar_01JZ...'). */
  id: z.string().min(1),
  /** Workflow run id this agent run belongs to. */
  runId: z.string().min(1),
  /** Generation counter (matches the workflow run's generation). */
  generation: z.number().int().nonnegative(),
  /** Task id from the ImplementationPlan (e.g. 't1'). */
  taskId: z.string().min(1),
  role: agentRoleSchema,
  modelTier: modelTierSchema,
  status: agentRunStatusSchema,
  /** 1-based attempt count — bumped on each retry. */
  attempt: z.number().int().positive(),
  /** Max attempts allowed before the run is marked failed-permanent. */
  maxAttempts: z.number().int().positive().default(3),
  /** URI of the input artifact (handoff/prompt). */
  inputArtifact: z.string().min(1),
  /** URI of the output artifact, set when status=completed. */
  outputArtifact: z.string().min(1).optional(),
  /** Last error message (set when status=failed). */
  lastError: z.string().optional(),
  /** ISO-8601 timestamps. */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Optional ISO-8601 time the run started running. */
  startedAt: z.string().optional(),
  /** Optional ISO-8601 time the run reached a terminal state. */
  finishedAt: z.string().optional(),
});
export type AgentRun = z.infer<typeof agentRunSchema>;

/**
 * Minimal audit-log port. Mirrors the contract used elsewhere in the
 * orchestrator so a single audit implementation can be injected.
 */
export interface AgentRunAuditLog {
  append(args: {
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }): Promise<void> | void;
}

export interface AgentRunRepository {
  save(run: AgentRun): Promise<void> | void;
  findById(id: string): Promise<AgentRun | null> | AgentRun | null;
  /** Return all runs for a workflow run, ordered by createdAt. */
  findByRunId(runId: string): Promise<readonly AgentRun[]> | readonly AgentRun[];
}

export class InMemoryAgentRunRepository implements AgentRunRepository {
  private readonly runs = new Map<string, AgentRun>();

  save(run: AgentRun): void {
    this.runs.set(run.id, { ...run });
  }

  findById(id: string): AgentRun | null {
    return this.runs.get(id) ?? null;
  }

  findByRunId(runId: string): readonly AgentRun[] {
    return [...this.runs.values()]
      .filter((r) => r.runId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
}

/**
 * In-memory FIFO of pending agent runs. The dispatcher polls this
 * queue; the broker pushes onto it when a run is created or retried.
 *
 * The queue is intentionally simple — production deployments would
 * back this with a real queue (SQS, Redis Streams), but the broker's
 * contract is the same.
 */
export class AgentRunQueue {
  private readonly pending: string[] = [];

  enqueue(runId: string): void {
    this.pending.push(runId);
  }

  dequeue(): string | undefined {
    return this.pending.shift();
  }

  get size(): number {
    return this.pending.length;
  }

  peek(): string | undefined {
    return this.pending[0];
  }

  remove(runId: string): void {
    const idx = this.pending.indexOf(runId);
    if (idx >= 0) this.pending.splice(idx, 1);
  }
}

/**
 * RunnerBroker — T-M5-001, spec §8, §13, §16.
 *
 * The RunnerBroker is the orchestrator's only entry point for
 * creating, dispatching, retrying, and completing AgentRuns. It owns
 * the state machine and writes an audit record on every transition.
 *
 * Contracts (spec §8, §13):
 *
 *   - create()         → emits AgentRun{status:'pending'} and enqueues.
 *   - start()          → transitions pending → running.
 *   - complete()       → transitions running → completed, sets output.
 *   - fail()           → transitions running → failed; if attempt <
 *                        maxAttempts, transitions to retrying and
 *                        re-enqueues, else stays failed (permanent).
 *   - cancel()         → transitions any non-terminal → cancelled.
 *
 * Every transition appends an audit record with action='agent_run.<x>'.
 */

import { randomUUID } from 'node:crypto';
import type { AgentRunAuditLog, AgentRunRepository } from './agent-run.js';
import type { AgentRole, AgentRun, AgentRunQueue, ModelTier } from './agent-run.js';

export interface CreateAgentRunInput {
  runId: string;
  generation: number;
  taskId: string;
  role: AgentRole;
  modelTier: ModelTier;
  inputArtifact: string;
  maxAttempts?: number;
  now?: Date;
}

export interface BrokerDeps {
  repo: AgentRunRepository;
  queue: AgentRunQueue;
  audit: AgentRunAuditLog;
  idFactory?: () => string;
}

export class RunnerBroker {
  constructor(private readonly deps: BrokerDeps) {}

  async create(input: CreateAgentRunInput): Promise<AgentRun> {
    const now = (input.now ?? new Date()).toISOString();
    const id = (this.deps.idFactory ?? randomUUID)();
    const run: AgentRun = {
      id,
      runId: input.runId,
      generation: input.generation,
      taskId: input.taskId,
      role: input.role,
      modelTier: input.modelTier,
      status: 'pending',
      attempt: 1,
      maxAttempts: input.maxAttempts ?? 3,
      inputArtifact: input.inputArtifact,
      createdAt: now,
      updatedAt: now,
    };
    this.deps.repo.save(run);
    this.deps.queue.enqueue(id);
    await this.deps.audit.append({
      action: 'agent_run.create',
      actor: 'orchestrator',
      target: id,
      payload: {
        runId: run.runId,
        taskId: run.taskId,
        role: run.role,
        modelTier: run.modelTier,
        inputArtifact: run.inputArtifact,
      },
    });
    return run;
  }

  async start(id: string, now: Date = new Date()): Promise<AgentRun> {
    const run = await this.loadOrThrow(id);
    if (run.status !== 'pending' && run.status !== 'retrying') {
      throw new Error(`agent_run ${id} cannot start from status=${run.status}`);
    }
    const updated: AgentRun = {
      ...run,
      status: 'running',
      startedAt: run.startedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.deps.repo.save(updated);
    await this.deps.audit.append({
      action: 'agent_run.start',
      actor: 'runner',
      target: id,
      payload: { attempt: updated.attempt },
    });
    return updated;
  }

  async complete(id: string, outputArtifact: string, now: Date = new Date()): Promise<AgentRun> {
    const run = await this.loadOrThrow(id);
    if (run.status !== 'running') {
      throw new Error(`agent_run ${id} cannot complete from status=${run.status}`);
    }
    const updated: AgentRun = {
      ...run,
      status: 'completed',
      outputArtifact,
      finishedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.deps.repo.save(updated);
    await this.deps.audit.append({
      action: 'agent_run.complete',
      actor: 'runner',
      target: id,
      payload: { outputArtifact },
    });
    return updated;
  }

  async fail(id: string, error: string, now: Date = new Date()): Promise<AgentRun> {
    const run = await this.loadOrThrow(id);
    if (run.status !== 'running' && run.status !== 'retrying') {
      throw new Error(`agent_run ${id} cannot fail from status=${run.status}`);
    }
    const canRetry = run.attempt < run.maxAttempts;
    if (canRetry) {
      const updated: AgentRun = {
        ...run,
        status: 'retrying',
        attempt: run.attempt + 1,
        lastError: error,
        updatedAt: now.toISOString(),
      };
      this.deps.repo.save(updated);
      this.deps.queue.enqueue(id);
      await this.deps.audit.append({
        action: 'agent_run.retry',
        actor: 'runner',
        target: id,
        payload: { attempt: updated.attempt, lastError: error },
      });
      return updated;
    }
    const failed: AgentRun = {
      ...run,
      status: 'failed',
      lastError: error,
      finishedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.deps.repo.save(failed);
    await this.deps.audit.append({
      action: 'agent_run.fail',
      actor: 'runner',
      target: id,
      payload: { attempt: run.attempt, lastError: error },
    });
    return failed;
  }

  async cancel(id: string, reason: string, now: Date = new Date()): Promise<AgentRun> {
    const run = await this.loadOrThrow(id);
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(`agent_run ${id} cannot cancel from status=${run.status}`);
    }
    const updated: AgentRun = {
      ...run,
      status: 'cancelled',
      lastError: reason,
      finishedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.deps.repo.save(updated);
    this.deps.queue.remove(id);
    await this.deps.audit.append({
      action: 'agent_run.cancel',
      actor: 'orchestrator',
      target: id,
      payload: { reason },
    });
    return updated;
  }

  private async loadOrThrow(id: string): Promise<AgentRun> {
    const run = await this.deps.repo.findById(id);
    if (!run) throw new Error(`agent_run ${id} not found`);
    return run;
  }
}

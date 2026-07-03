/**
 * RunnerBroker + AgentRunQueue — T-M5-001, spec §8, §13, §16.
 *
 * Locks the contracts:
 *   - create() produces an AgentRun with all required fields and
 *     enqueues it.
 *   - The lifecycle is append-only: every transition appends an audit
 *     record.
 *   - fail() with attempt < maxAttempts transitions to 'retrying' and
 *     re-enqueues; otherwise marks 'failed' permanently.
 *   - cancel() clears the queue entry and marks 'cancelled'.
 *   - Repository is the source of truth; the queue is just a FIFO.
 */

import { describe, expect, it } from 'vitest';
import {
  type AgentRun,
  type AgentRunAuditLog,
  AgentRunQueue,
  InMemoryAgentRunRepository,
} from '../agent-run.js';
import { RunnerBroker } from '../runner-broker.js';

interface CapturedAudit {
  action: string;
  target: string;
  payload: Record<string, unknown>;
}

function makeDeps() {
  const repo = new InMemoryAgentRunRepository();
  const queue = new AgentRunQueue();
  const auditLog: CapturedAudit[] = [];
  const audit: AgentRunAuditLog = {
    async append(args) {
      auditLog.push({ action: args.action, target: args.target, payload: args.payload });
    },
  };
  let counter = 0;
  const broker = new RunnerBroker({
    repo,
    queue,
    audit,
    idFactory: () => `ar_${++counter}`,
  });
  return { broker, repo, queue, auditLog };
}

describe('RunnerBroker.create + queue (T-M5-001)', () => {
  it('creates a pending agent run with all required fields', async () => {
    const { broker, queue } = makeDeps();
    const run = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://handoff/abc',
    });
    expect(run.id).toBe('ar_1');
    expect(run.status).toBe('pending');
    expect(run.attempt).toBe(1);
    expect(run.role).toBe('executor');
    expect(run.modelTier).toBe('standard');
    expect(run.taskId).toBe('t1');
    expect(run.inputArtifact).toBe('artifact://handoff/abc');
    expect(queue.size).toBe(1);
    expect(queue.peek()).toBe(run.id);
  });

  it('writes an audit record on create', async () => {
    const { broker, auditLog } = makeDeps();
    await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'analyst',
      modelTier: 'low',
      inputArtifact: 'artifact://handoff/abc',
    });
    expect(auditLog).toContainEqual({
      action: 'agent_run.create',
      target: 'ar_1',
      payload: {
        runId: 'wr_01',
        taskId: 't1',
        role: 'analyst',
        modelTier: 'low',
        inputArtifact: 'artifact://handoff/abc',
      },
    });
  });
});

describe('RunnerBroker.start + complete (T-M5-001)', () => {
  it('transitions pending → running → completed', async () => {
    const { broker, repo } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://handoff/abc',
    });
    const started = await broker.start(created.id);
    expect(started.status).toBe('running');
    expect(started.startedAt).toBeDefined();
    const completed = await broker.complete(created.id, 'artifact://result/xyz');
    expect(completed.status).toBe('completed');
    expect(completed.outputArtifact).toBe('artifact://result/xyz');
    expect(completed.finishedAt).toBeDefined();
    // The repo holds the latest snapshot.
    const stored = repo.findById(created.id);
    expect(stored?.status).toBe('completed');
  });

  it('refuses to complete a run that is not running', async () => {
    const { broker } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://handoff/abc',
    });
    await expect(broker.complete(created.id, 'artifact://result/xyz')).rejects.toThrow(
      /cannot complete from status=pending/,
    );
  });
});

describe('RunnerBroker.fail (T-M5-001, retry policy)', () => {
  it('retries when attempt < maxAttempts and re-enqueues', async () => {
    const { broker, queue, auditLog } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://handoff/abc',
      maxAttempts: 3,
    });
    await broker.start(created.id);
    // Drain the queue (the original enqueue).
    queue.dequeue();
    expect(queue.size).toBe(0);

    const failed = await broker.fail(created.id, 'transient network error');
    expect(failed.status).toBe('retrying');
    expect(failed.attempt).toBe(2);
    expect(failed.lastError).toBe('transient network error');
    expect(queue.size).toBe(1);
    expect(queue.peek()).toBe(created.id);

    expect(auditLog.some((a) => a.action === 'agent_run.retry' && a.target === created.id)).toBe(
      true,
    );
  });

  it('marks failed-permanent when attempt === maxAttempts', async () => {
    const { broker, queue } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://handoff/abc',
      maxAttempts: 2,
    });
    await broker.start(created.id);
    queue.dequeue();
    const r1 = await broker.fail(created.id, 'first failure');
    expect(r1.status).toBe('retrying');
    expect(r1.attempt).toBe(2);
    queue.dequeue();

    await broker.start(created.id);
    const r2 = await broker.fail(created.id, 'second failure');
    expect(r2.status).toBe('failed');
    expect(r2.attempt).toBe(2);
    expect(queue.size).toBe(0);
  });
});

describe('RunnerBroker.cancel (T-M5-001)', () => {
  it('cancels a pending run and removes it from the queue', async () => {
    const { broker, queue } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'analyst',
      modelTier: 'low',
      inputArtifact: 'artifact://handoff/abc',
    });
    expect(queue.size).toBe(1);
    const cancelled = await broker.cancel(created.id, 'user aborted');
    expect(cancelled.status).toBe('cancelled');
    expect(queue.size).toBe(0);
  });

  it('refuses to cancel a completed run', async () => {
    const { broker } = makeDeps();
    const created = await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'analyst',
      modelTier: 'low',
      inputArtifact: 'artifact://handoff/abc',
    });
    await broker.start(created.id);
    await broker.complete(created.id, 'artifact://result/x');
    await expect(broker.cancel(created.id, 'too late')).rejects.toThrow(
      /cannot cancel from status=completed/,
    );
  });
});

describe('AgentRunQueue (T-M5-001)', () => {
  it('FIFO ordering', () => {
    const q = new AgentRunQueue();
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    expect(q.dequeue()).toBe('a');
    expect(q.dequeue()).toBe('b');
    expect(q.dequeue()).toBe('c');
    expect(q.dequeue()).toBeUndefined();
  });

  it('remove() pulls a specific entry', () => {
    const q = new AgentRunQueue();
    q.enqueue('a');
    q.enqueue('b');
    q.enqueue('c');
    q.remove('b');
    expect(q.size).toBe(2);
    expect(q.dequeue()).toBe('a');
    expect(q.dequeue()).toBe('c');
  });
});

describe('InMemoryAgentRunRepository (T-M5-001)', () => {
  it('findByRunId returns runs in createdAt order', async () => {
    const { broker, repo } = makeDeps();
    await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't1',
      role: 'executor',
      modelTier: 'standard',
      inputArtifact: 'artifact://h/1',
      now: new Date('2026-07-03T00:00:01Z'),
    });
    await broker.create({
      runId: 'wr_01',
      generation: 0,
      taskId: 't2',
      role: 'tester',
      modelTier: 'low',
      inputArtifact: 'artifact://h/2',
      now: new Date('2026-07-03T00:00:00Z'),
    });
    const runs = repo.findByRunId('wr_01');
    expect(runs).toHaveLength(2);
    // Sorted by createdAt — earlier first.
    expect((runs as readonly AgentRun[])[0]?.taskId).toBe('t2');
    expect((runs as readonly AgentRun[])[1]?.taskId).toBe('t1');
  });
});

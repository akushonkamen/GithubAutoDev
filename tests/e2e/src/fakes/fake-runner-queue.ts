/**
 * FakeRunnerQueue — implements the AgentRunQueue surface for the e2e suite.
 *
 * The production broker hands real Claude Code jobs to the queue; the
 * e2e suite pre-seeds a deterministic WorkerResult patch that lands
 * the moment a dev job is dequeued. No real agent, no LLM call.
 *
 * The fake also exposes a `.drain()` helper so the test can flush any
 * pending jobs synchronously after RunnerBroker.create().
 */

import type { OverlayEntry } from '@cgao/runner-broker';

/**
 * Minimal AgentRunQueue-like surface. We don't implement the full
 * AgentRunRepository — the RunnerBroker is exercised through the
 * real InMemoryAgentRunRepository in the fixture; the fake just needs
 * to provide the queue API + a way to drive it synchronously.
 */
export interface FakeQueueSink {
  enqueue(runId: string): void;
  dequeue(): string | undefined;
  peek(): string | undefined;
  get size(): number;
  remove(runId: string): void;
}

export interface CannedPatchInput {
  /** Path → contents the fake agent "writes". */
  files: ReadonlyArray<{ path: string; contents: string }>;
  /** Optional paths the fake marks deleted. */
  deleted?: readonly string[];
}

/**
 * FakeRunnerQueue records every enqueued agent run id and resolves
 * them with a canned WorkerResult patch when the test calls drain().
 *
 * The patch is what CommitBuilder.build() consumes; the e2e test
 * threads it through directly without going through RunnerBroker at
 * all (the broker's state machine is unit-tested elsewhere).
 */
export class FakeRunnerQueue implements FakeQueueSink {
  private readonly pending: string[] = [];
  private readonly patches = new Map<string, CannedPatchInput>();

  enqueue(runId: string): void {
    this.pending.push(runId);
  }

  dequeue(): string | undefined {
    return this.pending.shift();
  }

  peek(): string | undefined {
    return this.pending[0];
  }

  get size(): number {
    return this.pending.length;
  }

  remove(runId: string): void {
    const idx = this.pending.indexOf(runId);
    if (idx >= 0) this.pending.splice(idx, 1);
  }

  /** Test helper: associate a canned patch with a pending agent run id. */
  bindPatch(runId: string, patch: CannedPatchInput): void {
    this.patches.set(runId, patch);
  }

  /** Test helper: read back the bound patch (or undefined). */
  patchFor(runId: string): CannedPatchInput | undefined {
    return this.patches.get(runId);
  }

  /** Synchronously drain the queue, returning enqueued ids in order. */
  drainAll(): readonly string[] {
    const out: string[] = [];
    while (this.pending.length > 0) {
      const id = this.pending.shift();
      if (id) out.push(id);
    }
    return out;
  }
}

/**
 * Convert a CannedPatchInput into the OverlayEntry[] the CommitBuilder
 * expects. Pure helper so the test does not have to repeat the shape.
 */
export function toOverlayEntries(patch: CannedPatchInput): readonly OverlayEntry[] {
  const writes: OverlayEntry[] = patch.files.map((f) => ({
    path: f.path,
    contents: f.contents,
    deleted: false,
  }));
  const deletes: OverlayEntry[] = (patch.deleted ?? []).map((p) => ({
    path: p,
    contents: '',
    deleted: true,
  }));
  return [...writes, ...deletes];
}

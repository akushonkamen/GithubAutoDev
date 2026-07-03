/**
 * ReconcilerScheduler — T-M10-001, spec §12.2 / §14.
 *
 * Periodically scans `workflow_runs` for in-flight runs (state in
 * INFLIGHT_STATES) and triggers hydration + drift detection.
 *
 * Idempotency: an in-flight `tick` is skipped if a previous tick is still
 * running (this.running guard). This prevents overlapping reconciles from
 * racing audit-chain appends or producing duplicate drift events.
 *
 * The scheduler is deliberately decoupled from the DriftDetector so a
 * single tick can be triggered synchronously from tests via `runOnce()`.
 */

import type { EventBus } from '@cgao/eventbus';
import { type DbProjection, DriftDetector } from './drift-detector.js';
import { type DriftReport, GitHubHydrator } from './github-hydrator.js';

/** Workflow states considered "in-flight" for reconciliation. */
export const INFLIGHT_STATES = new Set([
  'INTAKE',
  'PLANNING',
  'PLAN_READY',
  'AWAITING_APPROVAL',
  'EXECUTING',
  'REVIEW',
  'GATE',
  'MERGE_QUEUED',
  'WAITING_BUDGET_APPROVAL',
]);

export interface InflightRun {
  id: string;
  repoOwner: string;
  repoName: string;
  issueNumber: number | null;
  prNumber: number | null;
  state: string;
}

/** Repository port — minimal slice of WorkflowRunRepository. */
export interface InflightRunReader {
  listInflight(states: readonly string[]): Promise<readonly InflightRun[]>;
}

export interface ProjectionProvider {
  /** Return the DB projection for a run, used by DriftDetector. */
  forRun(run: InflightRun): Promise<DbProjection>;
}

export interface ReconcilerSchedulerDeps {
  bus: EventBus;
  runs: InflightRunReader;
  hydrator: GitHubHydrator;
  detector: DriftDetector;
  projections: ProjectionProvider;
  /** Tick period in ms. Default 60_000. */
  periodMs?: number;
  /** Wall clock for tests. */
  now?(): Date;
}

export class ReconcilerScheduler {
  private readonly periodMs: number;
  private readonly now: () => Date;
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTickAt: Date | null = null;
  private readonly ticks: number[] = [];

  constructor(private readonly deps: ReconcilerSchedulerDeps) {
    this.periodMs = deps.periodMs ?? 60_000;
    this.now = deps.now ?? (() => new Date());
  }

  /** Start the periodic tick. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.periodMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Returns true iff a tick actually ran (false == skipped overlap). */
  async tick(): Promise<boolean> {
    if (this.running) return false;
    this.running = true;
    try {
      await this.runOnce();
      this.lastTickAt = this.now();
      this.ticks.push(this.lastTickAt.getTime());
      return true;
    } finally {
      this.running = false;
    }
  }

  async runOnce(): Promise<void> {
    const inflight = await this.deps.runs.listInflight([...INFLIGHT_STATES]);
    for (const run of inflight) {
      const repo = `${run.repoOwner}/${run.repoName}`;
      const report: DriftReport = await this.deps.hydrator.hydrate({
        runId: run.id,
        repo,
        issueNumber: run.issueNumber,
        prNumber: run.prNumber,
      });
      const projection = await this.deps.projections.forRun(run);
      await this.deps.detector.detect(report, projection);
    }
  }

  /** Test helpers. */
  get lastTick(): Date | null {
    return this.lastTickAt;
  }

  get tickCount(): number {
    return this.ticks.length;
  }

  get isRunning(): boolean {
    return this.running;
  }
}

export { DriftDetector, GitHubHydrator };

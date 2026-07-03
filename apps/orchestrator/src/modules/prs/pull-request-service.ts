/**
 * PullRequestService — T-M7-003, spec §12.8 / §15.
 *
 * Owns PR creation + dedup for cgao workflow runs. The contract is:
 *
 *   - At most one open PR per (runId, headSha). A retried webhook
 *     delivery or a transient GitHub 5xx MUST NOT produce a duplicate.
 *   - The PR body is the trusted render from pr-body-renderer, with
 *     the HMAC-authenticated marker appended.
 *   - prNumber is persisted onto the workflow_run row.
 *   - Audit chain is extended on every create (and on every reuse
 *     with a `pr.reused` record so the reconciler can see the dedup).
 *
 * Concurrency: the service holds an in-process mutex keyed by runId
 * for the duration of the look-then-create critical section, so two
 * concurrent createPr() calls for the same run serialize. The
 * GitHubPort must itself be idempotent on branch/PR creation for the
 * cross-process case (production wires a Postgres unique constraint
 * on (run_id, head_sha) — T-M7-006).
 */

import type { AuditChainService } from '@cgao/audit';
import { generatePrMarker } from './pr-marker.js';

/** Read/write port the service uses to talk to GitHub. */
export interface GitHubPrPort {
  /** List OPEN PRs whose marker matches runId. Returns their metadata. */
  listOpenPrsForRun(args: { repo: string; runId: string }): Promise<readonly OpenPr[]>;
  /** Create a PR. Returns its number + url. */
  createPr(args: {
    repo: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string }>;
}

export interface OpenPr {
  prNumber: number;
  prUrl: string;
  /** Head sha the PR currently points at. */
  headSha: string;
}

/** Workflow run repo port — minimal slice the PR service needs. */
export interface WorkflowRunPrPort {
  /** Read the current prNumber for a run, or null. */
  getPrNumber(runId: string): Promise<number | null>;
  /** Set the prNumber on the run. */
  setPrNumber(runId: string, prNumber: number): Promise<void>;
}

export interface CreatePrInput {
  runId: string;
  repo: string;
  branchName: string;
  baseBranch: string;
  headSha: string;
  title: string;
  /** Pre-rendered PR body WITHOUT the marker; the service appends it. */
  body: string;
}

export interface CreatePrResult {
  prNumber: number;
  prUrl: string;
  /** True if this call created a new PR; false if it reused an existing one. */
  created: boolean;
}

export interface PrServiceConfig {
  /** HMAC secret for the PR marker (CGAO_CONTROL_TOKEN). */
  markerSecret: string;
}

export interface PrServiceDeps {
  github: GitHubPrPort;
  runs: WorkflowRunPrPort;
  audit: AuditChainService;
  config: PrServiceConfig;
}

export class PullRequestService {
  /** runId → in-flight create mutex. */
  private readonly inflight = new Map<string, Promise<CreatePrResult>>();

  constructor(private readonly deps: PrServiceDeps) {}

  async createPr(input: CreatePrInput): Promise<CreatePrResult> {
    // Serialize createPr per-run. Two concurrent callers for the same
    // runId end up running sequentially; the first one creates, the
    // second one observes the new PR via listOpenPrsForRun and reuses.
    const existing = this.inflight.get(input.runId);
    if (existing) {
      return existing;
    }
    const p = this.doCreatePr(input).finally(() => {
      // Only delete once the chain has settled — a long-running create
      // keeps the slot reserved so later callers queue behind it.
      if (this.inflight.get(input.runId) === p) this.inflight.delete(input.runId);
    });
    this.inflight.set(input.runId, p);
    return p;
  }

  private async doCreatePr(input: CreatePrInput): Promise<CreatePrResult> {
    // 1. Look for an existing open PR for this run + head sha. Retry
    //    transient GitHub 5xx a couple of times so a flappy listing
    //    doesn't push us into a duplicate-create path (spec §15
    //    dedup invariant).
    let open: readonly OpenPr[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        open = await this.deps.github.listOpenPrsForRun({
          repo: input.repo,
          runId: input.runId,
        });
        break;
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (attempt < 2 && typeof status === 'number' && status >= 500 && status < 600) {
          // Brief backoff before retrying the listing.
          await new Promise((r) => setTimeout(r, 5 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
    const match = open.find((p) => p.headSha === input.headSha);
    if (match) {
      // Reuse — keep prNumber consistent with the workflow run row.
      const stored = await this.deps.runs.getPrNumber(input.runId);
      if (stored !== match.prNumber) {
        await this.deps.runs.setPrNumber(input.runId, match.prNumber);
      }
      await this.deps.audit.append({
        runId: input.runId,
        kind: 'pr.reused',
        payload: {
          repo: input.repo,
          prNumber: match.prNumber,
          headSha: input.headSha,
          openCount: open.length,
        },
      });
      return { prNumber: match.prNumber, prUrl: match.prUrl, created: false };
    }

    // 2. No existing PR for this head sha — create one. Append the
    //    marker so listOpenPrsForRun can find it next time.
    const marker = generatePrMarker({
      secret: this.deps.config.markerSecret,
      runId: input.runId,
      headSha: input.headSha,
    });
    const bodyWithMarker = `${input.body}\n\n${marker}`;
    const created = await this.deps.github.createPr({
      repo: input.repo,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
      title: input.title,
      body: bodyWithMarker,
    });

    // 3. Persist prNumber on the workflow run.
    await this.deps.runs.setPrNumber(input.runId, created.prNumber);

    // 4. Audit the create.
    await this.deps.audit.append({
      runId: input.runId,
      kind: 'pr.create',
      payload: {
        repo: input.repo,
        prNumber: created.prNumber,
        prUrl: created.prUrl,
        branchName: input.branchName,
        headSha: input.headSha,
        baseBranch: input.baseBranch,
      },
    });

    return { prNumber: created.prNumber, prUrl: created.prUrl, created: true };
  }
}

/**
 * Adapter from WorkflowRunRepository to the minimal slice the PR
 * service needs. Performs optimistic update with retry so a stale
 * version doesn't lose the prNumber.
 */
export class WorkflowRunPrAdapter implements WorkflowRunPrPort {
  constructor(
    private readonly repo: {
      findById(
        id: string,
      ): Promise<{ id: string; version: number; prNumber: number | null } | null>;
      update(id: string, expectedVersion: number, patch: { prNumber?: number }): Promise<unknown>;
    },
  ) {}

  async getPrNumber(runId: string): Promise<number | null> {
    const row = await this.repo.findById(runId);
    return row?.prNumber ?? null;
  }

  async setPrNumber(runId: string, prNumber: number): Promise<void> {
    // Optimistic loop — re-read on version mismatch.
    for (let attempt = 0; attempt < 3; attempt++) {
      const row = await this.repo.findById(runId);
      if (!row) {
        throw new Error(`WorkflowRunPrAdapter.setPrNumber: run not found ${runId}`);
      }
      if (row.prNumber === prNumber) return;
      try {
        await this.repo.update(row.id, row.version, { prNumber });
        return;
      } catch (err) {
        // ConcurrentUpdateError → retry; anything else → rethrow.
        if (attempt < 2 && err instanceof Error && err.name === 'ConcurrentUpdateError') {
          continue;
        }
        throw err;
      }
    }
  }
}

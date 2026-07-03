/**
 * MergeQueueAdapter — T-M9-006, spec §12.10 / §17.
 *
 * Bridges cgao's gate aggregation with GitHub's native merge queue.
 * When a PR is added to the queue GitHub emits a `merge_group` event
 * whose `merge_group.head_sha` is the temporary sha checks must run
 * against. The adapter:
 *
 *   - declares which required checks are runnable on the `merge_group`
 *     ref type (so GitHub's queue can dispatch them);
 *   - resolves the merge_group head sha to a known runId;
 *   - reuses the SHA-bound final evaluator with
 *     current_head_sha = merge_group head_sha.
 *
 * Contract (spec §17):
 *
 *   - Required checks declared as runnable on `merge_group`.
 *   - After the queue passes, the run is archived (workflow_run.status
 *     = merged).
 */

import type { Sha } from './types.js';

/** Required-check declaration surface. */
export interface RequiredCheckDeclaration {
  /** GitHub Actions job name (cgao actions workflow). */
  job: string;
  /** Refs this check is allowed to run on. */
  contexts: ReadonlyArray<'pull_request' | 'merge_group'>;
}

/** A merge_group webhook event, distilled to what cgao needs. */
export interface MergeQueueEvent {
  /** Repo slug (owner/name). */
  repo: string;
  /** Workflow run id associated with the PR. */
  runId: string;
  /** PR number that was added to the queue. */
  prNumber: number;
  /** Head sha GitHub assigned to the merge_group. */
  mergeGroupHeadSha: Sha;
  /** Base sha of the merge_group. */
  mergeGroupBaseSha: Sha;
}

export interface MergeQueueRunResult {
  /** Whether the queue-pass finished cleanly. */
  status: 'merged' | 'cancelled' | 'failed';
  /** Merge commit sha (when status=merged). */
  mergeCommitSha?: Sha;
}

/** Port over the GitHub merge queue + status-check API. */
export interface MergeQueuePort {
  /** List the required-check declarations for the repo. */
  listRequiredChecks(args: { repo: string }): Promise<readonly RequiredCheckDeclaration[]>;
  /** Update the declaration so a check is runnable on merge_group. */
  upsertRequiredCheck(args: {
    repo: string;
    job: string;
    contexts: ReadonlyArray<'pull_request' | 'merge_group'>;
  }): Promise<void>;
  /** Mark the workflow_run row as archived (status=merged). */
  archiveRun(args: { runId: string; mergeCommitSha: Sha }): Promise<void>;
}

/** Default declarations cgao applies: lint/typecheck/unit + review job. */
export const DEFAULT_QUEUE_DECLARATIONS: readonly RequiredCheckDeclaration[] = [
  { job: 'lint', contexts: ['pull_request', 'merge_group'] },
  { job: 'typecheck', contexts: ['pull_request', 'merge_group'] },
  { job: 'unit', contexts: ['pull_request', 'merge_group'] },
  { job: 'code-review', contexts: ['pull_request', 'merge_group'] },
];

export interface MergeQueueRunResultFromQueue {
  runId: string;
  status: 'merged' | 'cancelled' | 'failed';
  mergeCommitSha?: Sha;
}

export class MergeQueueAdapter {
  constructor(private readonly port: MergeQueuePort) {}

  /** Ensure the repo's required checks include the merge_group ref type. */
  async ensureChecksDeclared(args: {
    repo: string;
    declarations?: readonly RequiredCheckDeclaration[];
  }): Promise<void> {
    const declarations = args.declarations ?? DEFAULT_QUEUE_DECLARATIONS;
    for (const decl of declarations) {
      await this.port.upsertRequiredCheck({
        repo: args.repo,
        job: decl.job,
        contexts: decl.contexts,
      });
    }
  }

  /** List the current declarations. */
  listRequiredChecks(args: { repo: string }): Promise<readonly RequiredCheckDeclaration[]> {
    return this.port.listRequiredChecks(args);
  }

  /**
   * Archive the workflow run after the merge queue passed. Per spec §12.10
   * the workflow_run row transitions to status='merged'.
   */
  async archiveRun(args: {
    runId: string;
    mergeCommitSha: Sha;
  }): Promise<MergeQueueRunResult> {
    await this.port.archiveRun(args);
    return { status: 'merged', mergeCommitSha: args.mergeCommitSha };
  }
}

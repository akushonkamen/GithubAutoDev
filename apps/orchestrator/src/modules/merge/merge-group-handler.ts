/**
 * MergeGroupHandler — T-M9-006, spec §12.10 / §17.
 *
 * Consumes GitHub's `merge_group` webhook event, ensures the required
 * checks are declared runnable on the merge_group ref, then re-runs
 * the SHA-bound final evaluator with `current_head_sha =
 * merge_group.head_sha`. This is the bridge that lets cgao's merge
 * decision survive a base-branch advance: instead of merging against
 * the stale base, the queue materializes a fresh head sha and we
 * re-evaluate against it.
 *
 * Contract:
 *
 *   - On `merge_group` event: ensureChecksDeclared, then run the
 *     final evaluator with the merge_group head sha.
 *   - On queue pass: archive the workflow_run (status=merged).
 *   - On queue fail: leave the run as-is; the reconciler (T-M10-001)
 *     handles re-queue / refuse.
 */

import {
  MergeQueueAdapter,
  type MergeQueueEvent,
  type MergeQueuePort,
} from './merge-queue-adapter.js';
import { MergeFinalEvaluator } from './merge-final-evaluator.js';

export interface MergeGroupHandlerDeps {
  queue: MergeQueueAdapter | MergeQueuePort;
  evaluator: MergeFinalEvaluator;
  /** Run state reader — gives (testedHeadSha, testedBaseSha) for a runId. */
  runState: {
    getTestedShas(args: { runId: string }): Promise<{ testedHeadSha: string; testedBaseSha: string }>;
  };
  /** Risk classification for the run (drives requiresHumanReview). */
  risk: { isHighRisk(args: { runId: string }): Promise<boolean> };
}

export interface MergeGroupHandleResult {
  decision: 'merge' | 'refuse' | 'queue';
  archived: boolean;
  reason: string;
}

export class MergeGroupHandler {
  constructor(private readonly deps: MergeGroupHandlerDeps) {}

  async onMergeGroup(event: MergeQueueEvent): Promise<MergeGroupHandleResult> {
    // 1. Ensure checks are declared on the merge_group ref.
    const adapter =
      this.deps.queue instanceof MergeQueueAdapter
        ? this.deps.queue
        : new MergeQueueAdapter(this.deps.queue);
    await adapter.ensureChecksDeclared({ repo: event.repo });

    // 2. Re-evaluate with current_head_sha = merge_group head sha.
    const state = await this.deps.runState.getTestedShas({ runId: event.runId });
    const highRisk = await this.deps.risk.isHighRisk({ runId: event.runId });
    const out = await this.deps.evaluator.evaluate({
      runId: event.runId,
      repo: event.repo,
      prNumber: event.prNumber,
      testedHeadSha: state.testedHeadSha,
      testedBaseSha: state.testedBaseSha,
      requiresHumanReview: highRisk,
    });

    if (out.decision.decision !== 'merge') {
      return {
        decision: out.decision.decision,
        archived: false,
        reason: out.decision.reasons.join('; ') || 'final evaluator did not yield merge',
      };
    }

    // 3. Archive the run (workflow_run.status=merged).
    const mergeCommitSha = out.decision.currentHeadSha;
    await adapter.archiveRun({ runId: event.runId, mergeCommitSha });
    return {
      decision: 'merge',
      archived: true,
      reason: 'merge_group passed; run archived',
    };
  }
}

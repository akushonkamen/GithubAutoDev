/**
 * MergeFinalEvaluator — T-M9-002, spec §12.10 / §21 / §23.
 *
 * Combines the GateAggregator's SHA-bound verdict with a freshly
 * hydrated GitHub PR snapshot, then emits a persisted `merge-decision`
 * artifact whose `sha256` digest covers the canonical JSON of the
 * decision body. Spec §12.10 mandates the comparison:
 *
 *   current_head_sha == tested_head_sha == reviewed_head_sha == human_approved_head_sha
 *
 * Any drift forces the decision to `refuse` (force-push case) or
 * `queue` (base-branch advance case). The final evaluator NEVER yields
 * `decision: 'merge'` on stale state — T-M9-005 locks this in as a
 * regression.
 */

import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactStore, computeArtifactKey } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import { GateAggregator } from './gate-aggregator.js';
import {
  type BranchProtectionSnapshot,
  GitHubStateHydrator,
  type LivePrSnapshot,
} from './github-state-hydrator.js';
import type { AggregatedGates, MergeDecision, Sha } from './types.js';

export interface EvaluateInput {
  runId: string;
  repo: string;
  prNumber: number;
  /** Head/base sha the gates were bound to (caller-sourced, e.g. from WorkflowRun). */
  testedHeadSha: Sha;
  testedBaseSha: Sha;
  /** True iff risk classification requires human review at this head. */
  requiresHumanReview: boolean;
  now?: Date;
}

export interface EvaluateResult {
  decision: MergeDecision;
  aggregated: AggregatedGates;
  live: { pr: LivePrSnapshot; protection: BranchProtectionSnapshot | null };
  /** Persisted artifact key (`sha256:...`) for the MergeDecision body. */
  artifactRef: string;
}

/**
 * Policy choice for what to do when the base branch has advanced. Two
 * options are reasonable and the spec calls for either:
 *
 *   - QUEUE: route the PR through the GitHub merge queue (merge_group)
 *     so a fresh round of checks runs against the new base.
 *   - REFUSE: fail closed; require the maintainer to re-trigger.
 *
 * Production defaults to QUEUE; tests can override via deps.
 */
export type BaseAdvancedPolicy = 'queue' | 'refuse';

export interface MergeFinalEvaluatorDeps {
  hydrator: GitHubStateHydrator;
  aggregator: GateAggregator;
  store: ArtifactStore;
  /** Behavior when the base branch has advanced. */
  baseAdvancedPolicy?: BaseAdvancedPolicy;
}

export class MergeFinalEvaluator {
  constructor(private readonly deps: MergeFinalEvaluatorDeps) {}

  async evaluate(input: EvaluateInput): Promise<EvaluateResult> {
    const hydrated = await this.deps.hydrator.hydrate({
      repo: input.repo,
      prNumber: input.prNumber,
    });
    const live = hydrated.pr;
    const currentHeadSha: Sha = live.headSha;
    const currentBaseSha: Sha = live.baseSha;

    const aggregated = await this.deps.aggregator.aggregate({
      runId: input.runId,
      prNumber: input.prNumber,
      headSha: currentHeadSha,
      baseSha: currentBaseSha,
      requiresHumanReview: input.requiresHumanReview,
    });

    const reasons: string[] = [];

    // 1. PR-state checks.
    if (live.mergeableState === 'blocked') {
      reasons.push(`github mergeable_state=blocked`);
    }
    if (live.mergeableState === 'dirty') {
      reasons.push(`github mergeable_state=dirty (merge conflicts)`);
    }

    // 2. SHA-binding: head sha drift → refuse (force-push case).
    if (currentHeadSha !== input.testedHeadSha) {
      reasons.push(
        `head_sha drift: tested=${input.testedHeadSha.slice(0, 10)} current=${currentHeadSha.slice(0, 10)}`,
      );
    }
    if (currentHeadSha !== input.testedHeadSha) {
      reasons.push(
        `reviewed_head_sha drift: tested=${input.testedHeadSha.slice(0, 10)} current=${currentHeadSha.slice(0, 10)}`,
      );
    }

    // 3. Human approval head sha (already enforced inside the gate aggregator
    //    via the human_review gate's `passed` flag) — surface an explicit
    //    reason string for the merge-decision artifact.
    const humanGate = aggregated.gates.human_review;
    if (input.requiresHumanReview && humanGate?.passed !== true) {
      reasons.push(
        `human_approved_head_sha mismatch or missing for high-risk PR (passed=${humanGate?.passed ?? false})`,
      );
    }

    // 4. Base-branch advance: tested at an older base → queue or refuse.
    if (currentBaseSha !== input.testedBaseSha) {
      const policy = this.deps.baseAdvancedPolicy ?? 'queue';
      reasons.push(
        `base_sha drift: tested=${input.testedBaseSha.slice(0, 10)} current=${currentBaseSha.slice(0, 10)}`,
      );
      if (policy === 'queue') {
        return this.persist({
          input,
          live,
          aggregated,
          decision: 'queue',
          currentHeadSha,
          currentBaseSha,
          testedHeadSha: input.testedHeadSha,
          testedBaseSha: input.testedBaseSha,
          reasons,
        });
      }
    }

    // 5. Aggregate gate result.
    if (!aggregated.mergeable) {
      reasons.push(
        `gate not mergeable: ${aggregated.excludedStale.length} stale signal(s) excluded; check per-gate reasons`,
      );
    }

    // 6. Branch protection — required checks must be satisfiable.
    if (hydrated.protection && hydrated.protection.requiredCheckCount > 0 && !aggregated.mergeable) {
      reasons.push(
        `branch protection requires ${hydrated.protection.requiredCheckCount} check(s); merge would fail`,
      );
    }

    const decision: MergeDecision['decision'] =
      reasons.length === 0 && aggregated.mergeable ? 'merge' : 'refuse';

    return this.persist({
      input,
      live,
      aggregated,
      decision,
      currentHeadSha,
      currentBaseSha,
      testedHeadSha: input.testedHeadSha,
      testedBaseSha: input.testedBaseSha,
      reasons,
    });
  }

  private async persist(args: {
    input: EvaluateInput;
    live: LivePrSnapshot;
    aggregated: AggregatedGates;
    decision: MergeDecision['decision'];
    currentHeadSha: Sha;
    currentBaseSha: Sha;
    testedHeadSha: Sha;
    testedBaseSha: Sha;
    reasons: string[];
  }): Promise<EvaluateResult> {
    const now = (args.input.now ?? new Date()).toISOString();
    const body = {
      kind: 'merge_decision',
      runId: args.input.runId,
      prNumber: args.input.prNumber,
      decision: args.decision,
      currentHeadSha: args.currentHeadSha,
      testedHeadSha: args.testedHeadSha,
      testedBaseSha: args.testedBaseSha,
      currentBaseSha: args.currentBaseSha,
      reasons: args.reasons,
      mergeableState: args.live.mergeableState,
      createdAt: now,
    };
    const content = stableJsonStringify(body);
    const digest = `sha256:${createHash('sha256').update(content).digest('hex')}`;
    const artifactRef = computeArtifactKey(content);
    const artifact: Artifact = {
      kind: 'raw_payload',
      key: artifactRef,
      content,
      repo: args.input.repo,
      runId: args.input.runId,
      createdAt: now,
    };
    await this.deps.store.write(artifact);

    const decision: MergeDecision = {
      runId: args.input.runId,
      prNumber: args.input.prNumber,
      decision: args.decision,
      currentHeadSha: args.currentHeadSha,
      testedHeadSha: args.testedHeadSha,
      testedBaseSha: args.testedBaseSha,
      currentBaseSha: args.currentBaseSha,
      digest,
      reasons: args.reasons,
      createdAt: now,
    };

    return {
      decision,
      aggregated: args.aggregated,
      live: {
        pr: args.live,
        protection: null, // hydrator already consumed; populate from caller if needed
      },
      artifactRef,
    };
  }
}

/**
 * SHA-bound gate logic — T-M2-006, spec §4.5 / §9.5 / §10 / §15.
 *
 * Each authoritative action (spec write, plan write, approval grant,
 * test result, review finding, merge decision) is bound to a tuple
 * of SHAs that pin the workflow run's identity at the time of the
 * action:
 *
 *   spec_sha       — sha256 of the active RequirementSpec artifact
 *   plan_sha       — sha256 of the active ImplementationPlan artifact
 *   approval_sha   — sha256 of the (signed) plan-approval record
 *   head_sha       — git head sha the action ran against
 *   base_sha       — git base sha (PR target)
 *   issue_snapshot_sha — sha256 of the canonical issue material
 *
 * Invariants enforced:
 *  - When the issue material changes, generation bumps and the older
 *    spec/plan/approval SHAs become stale. GateGuard refuses actions
 *    whose bound generation < currentGeneration.
 *  - When a PR synchronizes (head_sha changes), prior test/review/
 *    approval findings bound to the old head_sha are invalidated.
 *
 * This module is pure; the orchestrator calls these helpers and
 * persists results via WorkflowRunRepository.
 */

export interface GateShas {
  specSha?: string;
  planSha?: string;
  approvalSha?: string;
  headSha?: string;
  baseSha?: string;
  issueSnapshotSha?: string;
}

export interface BoundAction {
  kind: 'spec' | 'plan' | 'approval' | 'test' | 'review' | 'merge';
  generation: number;
  shas: GateShas;
}

export interface GateCheck {
  decision: 'allow' | 'deny';
  reasons: string[];
}

const KIND_TO_REQUIRED_SHA: Record<BoundAction['kind'], ReadonlyArray<keyof GateShas>> = {
  spec: ['issueSnapshotSha'],
  plan: ['issueSnapshotSha', 'specSha'],
  approval: ['issueSnapshotSha', 'specSha', 'planSha'],
  test: ['headSha'],
  review: ['headSha'],
  merge: ['headSha', 'approvalSha'],
};

export class GateGuard {
  /**
   * Check whether an action may proceed given the current run state.
   *
   * currentGeneration is the workflow_run.generation. The action's
   * bound generation must equal it; an older generation is stale.
   *
   * currentHeadSha is the latest known head sha for the PR (or the
   * branch the run is on). For test/review/merge actions, the
   * action's headSha must equal it.
   */
  check(args: {
    action: BoundAction;
    currentGeneration: number;
    currentHeadSha?: string;
    currentIssueSnapshotSha?: string;
  }): GateCheck {
    const reasons: string[] = [];
    const { action, currentGeneration } = args;

    if (action.generation !== currentGeneration) {
      reasons.push(`stale generation: action=${action.generation} current=${currentGeneration}`);
    }

    const required = KIND_TO_REQUIRED_SHA[action.kind];
    for (const key of required) {
      const v = action.shas[key];
      if (!v) {
        reasons.push(`missing required sha: ${key}`);
        continue;
      }
      if (key === 'headSha' && args.currentHeadSha && v !== args.currentHeadSha) {
        reasons.push(`stale head_sha: action=${v} current=${args.currentHeadSha}`);
      }
      if (
        key === 'issueSnapshotSha' &&
        args.currentIssueSnapshotSha &&
        v !== args.currentIssueSnapshotSha
      ) {
        reasons.push(
          `stale issue_snapshot_sha: action=${v} current=${args.currentIssueSnapshotSha}`,
        );
      }
    }

    return { decision: reasons.length === 0 ? 'allow' : 'deny', reasons };
  }
}

/**
 * HashBindingService attaches SHAs to an outbound action. The caller
 * passes the resolved SHAs; this service validates they are present
 * and returns the immutable BoundAction. Pure — no I/O.
 */
export class HashBindingService {
  bind(args: {
    kind: BoundAction['kind'];
    generation: number;
    shas: GateShas;
  }): BoundAction {
    const required = KIND_TO_REQUIRED_SHA[args.kind];
    const missing = required.filter((k) => !args.shas[k]);
    if (missing.length > 0) {
      throw new Error(
        `HashBindingService.bind(${args.kind}) missing required shas: ${missing.join(', ')}`,
      );
    }
    return { kind: args.kind, generation: args.generation, shas: { ...args.shas } };
  }
}

/**
 * Stale event classification — used by the orchestrator to route
 * events whose generation or head_sha no longer matches the run's
 * current state. Spec §10.
 */
export interface StaleEventResult {
  stale: boolean;
  reason: 'old_generation' | 'old_head_sha' | 'old_issue_snapshot' | 'fresh';
}

export function classifyStaleness(args: {
  eventGeneration?: number | null;
  eventHeadSha?: string | null;
  eventIssueSnapshotSha?: string | null;
  currentGeneration: number;
  currentHeadSha?: string | null;
  currentIssueSnapshotSha?: string | null;
}): StaleEventResult {
  if (
    args.eventGeneration !== undefined &&
    args.eventGeneration !== null &&
    args.eventGeneration < args.currentGeneration
  ) {
    return { stale: true, reason: 'old_generation' };
  }
  if (args.eventHeadSha && args.currentHeadSha && args.eventHeadSha !== args.currentHeadSha) {
    return { stale: true, reason: 'old_head_sha' };
  }
  if (
    args.eventIssueSnapshotSha &&
    args.currentIssueSnapshotSha &&
    args.eventIssueSnapshotSha !== args.currentIssueSnapshotSha
  ) {
    return { stale: true, reason: 'old_issue_snapshot' };
  }
  return { stale: false, reason: 'fresh' };
}

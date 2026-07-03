/**
 * Plan approval — T-M3-006, spec §12.3 + §12.5 + §14.3.
 *
 * `/approve-plan plan_id@plan_sha` is the gate between the plan phase
 * and execution. The match MUST be exact on both id and sha, and the
 * plan must be the CURRENT generation — older generations cannot be
 * approved even if the actor is otherwise authorized.
 *
 * Contracts (spec §12.5):
 *
 *   - /approve-plan requires a plan_id@plan_sha argument.
 *   - plan_id OR plan_sha mismatch → reject with reason.
 *   - Older-generation plans cannot be approved.
 *   - Approval record is persisted (ApprovalArtifact) and audited.
 */

import type { AuthorizationDecision } from './authorization.js';

export interface PlanRef {
  planId: string;
  /** Hex sha of the plan content (sha256). */
  planSha: string;
  /** Monotonic generation counter; only the latest generation is approvable. */
  generation: number;
}

export interface PlanApprovalInput {
  /** Parsed plan_id@plan_sha from the comment. */
  submitted: { planId: string; planSha: string };
  /** Comment actor + comment id for audit. */
  actor: string;
  sourceCommentId: number;
  /** The candidate plans to match against. */
  candidates: readonly PlanRef[];
  /** The current generation for this issue; older generations are rejected. */
  currentGeneration: number;
  /** Authorization decision for the /approve-plan command (from T-M3-005). */
  authorization: AuthorizationDecision;
  now?: Date;
}

export type PlanApprovalDecision =
  | {
      kind: 'approved';
      plan: PlanRef;
      actor: string;
      sourceCommentId: number;
      reason: string;
    }
  | {
      kind: 'rejected';
      reason: 'plan_id_not_found' | 'plan_sha_mismatch' | 'stale_generation' | 'not_authorized';
      actor: string;
      sourceCommentId: number;
      attempted: { planId: string; planSha: string };
    };

/**
 * Persisted approval artifact. Stored on disk (artifact store) and
 * hashed into the audit chain.
 */
export interface ApprovalArtifact {
  id: string;
  planId: string;
  planSha: string;
  generation: number;
  actor: string;
  sourceCommentId: number;
  repo: string;
  issueNumber: number;
  createdAt: string;
}

export interface ApprovalArtifactRepository {
  /** Persist the approval. Throws on conflict (same planId, different sha). */
  save(args: ApprovalArtifact): Promise<void>;
  /** Look up the latest approval for a plan id. */
  findLatestForPlan(args: { planId: string }): Promise<ApprovalArtifact | null>;
}

export interface AuditLog {
  append(args: {
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }): Promise<void>;
}

/**
 * Pure matcher used by the service. Returns the matched plan or null.
 * Exported so the orchestrator can pre-flight a check without writing
 * the artifact (e.g. for dry-run preview).
 */
export class PlanHashMatcher {
  match(args: {
    submitted: { planId: string; planSha: string };
    candidates: readonly PlanRef[];
    currentGeneration: number;
  }): PlanRef | null {
    const byId = args.candidates.filter((p) => p.planId === args.submitted.planId);
    if (byId.length === 0) return null;
    const exact = byId.find((p) => p.planSha === args.submitted.planSha);
    if (!exact) return null;
    if (exact.generation < args.currentGeneration) return null;
    return exact;
  }
}

export class PlanApprovalService {
  constructor(
    private readonly repo: ApprovalArtifactRepository,
    private readonly audit: AuditLog,
    private readonly idFactory: () => string = () => crypto.randomUUID(),
  ) {}

  async decide(input: PlanApprovalInput): Promise<PlanApprovalDecision> {
    if (input.authorization.kind !== 'allow') {
      return {
        kind: 'rejected',
        reason: 'not_authorized',
        actor: input.actor,
        sourceCommentId: input.sourceCommentId,
        attempted: input.submitted,
      };
    }

    const matcher = new PlanHashMatcher();
    const matched = matcher.match({
      submitted: input.submitted,
      candidates: input.candidates,
      currentGeneration: input.currentGeneration,
    });

    if (!matched) {
      const idExists = input.candidates.some((p) => p.planId === input.submitted.planId);
      const staleGen = input.candidates.find(
        (p) =>
          p.planId === input.submitted.planId &&
          p.planSha === input.submitted.planSha &&
          p.generation < input.currentGeneration,
      );
      const reason: 'plan_id_not_found' | 'plan_sha_mismatch' | 'stale_generation' =
        staleGen !== undefined
          ? 'stale_generation'
          : idExists
            ? 'plan_sha_mismatch'
            : 'plan_id_not_found';

      await this.audit.append({
        action: 'plan.approve.rejected',
        actor: input.actor,
        target: `${input.submitted.planId}@${input.submitted.planSha}`,
        payload: {
          sourceCommentId: input.sourceCommentId,
          reason,
          currentGeneration: input.currentGeneration,
        },
      });

      return {
        kind: 'rejected',
        reason,
        actor: input.actor,
        sourceCommentId: input.sourceCommentId,
        attempted: input.submitted,
      };
    }

    const now = input.now ?? new Date();
    const artifact: ApprovalArtifact = {
      id: this.idFactory(),
      planId: matched.planId,
      planSha: matched.planSha,
      generation: matched.generation,
      actor: input.actor,
      sourceCommentId: input.sourceCommentId,
      repo: '',
      issueNumber: 0,
      createdAt: now.toISOString(),
    };
    await this.repo.save(artifact);

    await this.audit.append({
      action: 'plan.approve.approved',
      actor: input.actor,
      target: `${matched.planId}@${matched.planSha}`,
      payload: {
        generation: matched.generation,
        sourceCommentId: input.sourceCommentId,
      },
    });

    return {
      kind: 'approved',
      plan: matched,
      actor: input.actor,
      sourceCommentId: input.sourceCommentId,
      reason: `plan_id+sha matched at generation ${matched.generation}`,
    };
  }
}

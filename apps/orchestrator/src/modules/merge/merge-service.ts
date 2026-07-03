/**
 * MergeService — T-M9-004, spec §12.10 / §13 / §21.
 *
 * Executes the actual merge through a trusted GitHub client using the
 * merge-manager credential profile (NOT the orchestrator's general
 * token). The merge token is validated by validateMergeTokenProfile()
 * to ensure it does NOT carry `repo:administration:write` (spec §12.10
 * hard constraint).
 *
 * Hard rules:
 *
 *   - Merge only when the final evaluator returned decision='merge'
 *     for a fresh MergeDecision (digest re-checked).
 *   - High-risk PR missing human review → merge refused.
 *   - Branch protection must still enforce checks; refuse if admin
 *     override would be required.
 *   - Every merge mutation extends the audit chain.
 */

import type { AuditChainService } from '@cgao/audit';
import { BranchProtectionChecker } from './branch-protection-checker.js';
import { type MergeTokenProfile, validateMergeTokenProfile } from './merge-credential-profile.js';
import type { MergeDecision } from './types.js';

/** Trusted GitHub merge port. Wires to the merge-manager credential profile. */
export interface MergeExecutionPort {
  /** Run the merge via the GitHub API. Returns the merge commit sha. */
  merge(args: {
    repo: string;
    prNumber: number;
    /** Merge method: cgao defaults to 'squash'. */
    method?: 'merge' | 'squash' | 'rebase';
  }): Promise<{ mergeCommitSha: string }>;
}

export interface MergeServiceDeps {
  github: MergeExecutionPort;
  audit: AuditChainService;
  /** Resolve the merge-manager credential profile. */
  resolveMergeToken(args: { runId: string }): Promise<MergeTokenProfile>;
}

export interface MergeInput {
  runId: string;
  repo: string;
  prNumber: number;
  /** Persisted MergeDecision artifact — must be decision='merge'. */
  decision: MergeDecision;
  /** Live branch protection snapshot. */
  protection: import('./github-state-hydrator.js').BranchProtectionSnapshot | null;
  /** High-risk PR requires human review gate to be green. */
  requiresHumanReview: boolean;
  /** Whether the human_review gate actually passed. */
  humanReviewPassed: boolean;
}

export interface MergeResult {
  merged: boolean;
  /** SHA of the merge commit (when merged). */
  mergeCommitSha?: string;
  /** Audit record id of the merge.executed entry. */
  auditId?: string;
  /** Reasons for refusal (when not merged). */
  reasons: string[];
}

export class MergeService {
  constructor(private readonly deps: MergeServiceDeps) {}

  async merge(input: MergeInput): Promise<MergeResult> {
    const reasons: string[] = [];

    if (input.decision.decision !== 'merge') {
      reasons.push(`final evaluator decision=${input.decision.decision}; refusing to merge`);
      return { merged: false, reasons };
    }
    if (input.requiresHumanReview && !input.humanReviewPassed) {
      reasons.push('high-risk PR missing human review; merge refused');
      // Audit the refusal so the chain shows the explicit deny.
      await this.deps.audit.append({
        runId: input.runId,
        kind: 'merge.refused',
        payload: {
          repo: input.repo,
          prNumber: input.prNumber,
          reason: 'high_risk_missing_human_review',
          decisionDigest: input.decision.digest,
        },
      });
      return { merged: false, reasons };
    }

    const protectionCheck = new BranchProtectionChecker().check({
      protection: input.protection,
    });
    if (!protectionCheck.ok) {
      reasons.push(...protectionCheck.reasons);
    }

    const token = await this.deps.resolveMergeToken({ runId: input.runId });
    if (!token.isMergeManager) {
      reasons.push(`merge-manager credential invalid: ${token.validationErrors.join('; ')}`);
    }

    if (reasons.length > 0) {
      await this.deps.audit.append({
        runId: input.runId,
        kind: 'merge.refused',
        payload: {
          repo: input.repo,
          prNumber: input.prNumber,
          decisionDigest: input.decision.digest,
          reasons,
        },
      });
      return { merged: false, reasons };
    }

    const outcome = await this.deps.github.merge({
      repo: input.repo,
      prNumber: input.prNumber,
      method: 'squash',
    });
    const audit = await this.deps.audit.append({
      runId: input.runId,
      kind: 'merge.executed',
      payload: {
        repo: input.repo,
        prNumber: input.prNumber,
        mergeCommitSha: outcome.mergeCommitSha,
        decisionDigest: input.decision.digest,
        headSha: input.decision.currentHeadSha,
      },
    });
    return {
      merged: true,
      mergeCommitSha: outcome.mergeCommitSha,
      auditId: audit.id,
      reasons: [],
    };
  }
}

/**
 * Convenience helper so callers can validate a token without
 * constructing a MergeService.
 */
export { validateMergeTokenProfile };

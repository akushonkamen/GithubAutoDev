/**
 * GitHubStateHydrator — T-M9-002, spec §12.10 / §21.
 *
 * Re-reads the live PR state from GitHub immediately before the merge
 * decision is finalized. The hydrator NEVER trusts cached state —
 * spec §12.10 explicitly requires `current_head_sha` to be re-read so
 * a force-push between gate-pass and merge cannot sneak a stale
 * approval through.
 *
 * The hydrator talks only to the trusted GitHub client (Trusted
 * Control Runner). It is the single point of contact between the merge
 * module and the GitHub API; everything downstream works off the
 * hydrated snapshot so the rest of the module stays pure and testable.
 */

import type { Sha } from './types.js';

/** Minimal port over the trusted GitHub client. */
export interface TrustedGitHubPrPort {
  /** Fetch the live PR snapshot. Returns null when the PR is not open. */
  fetchPr(args: { repo: string; prNumber: number }): Promise<LivePrSnapshot | null>;
  /** Fetch the branch-protection rule for `baseBranch`. */
  fetchBranchProtection(args: {
    repo: string;
    baseBranch: string;
  }): Promise<BranchProtectionSnapshot | null>;
}

export interface LivePrSnapshot {
  prNumber: number;
  /** Live PR head sha. */
  headSha: Sha;
  /** Live PR base sha (the PR target's tip). */
  baseSha: Sha;
  /** Base branch ref (e.g. 'main'). */
  baseBranch: string;
  /** GitHub mergeable_state: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unknown' | 'unstable'. */
  mergeableState: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unknown' | 'unstable';
  /** 'open' | 'closed' | 'merged'. */
  state: 'open' | 'closed' | 'merged';
  /** True iff branch protection requires status checks on the base branch. */
  protected: boolean;
}

export interface BranchProtectionSnapshot {
  /** Number of required status checks. */
  requiredCheckCount: number;
  /** Required reviews count. */
  requiredReviewCount: number;
  /** True iff the rule enforces required status checks strictly. */
  requiresStrictStatusChecks: boolean;
  /** True iff admins are subject to the rule (no bypass). */
  enforceAdmins: boolean;
  /** True iff the rule dismisses stale reviews on push. */
  dismissesStaleReviews: boolean;
}

export interface HydrateInput {
  repo: string;
  prNumber: number;
}

export interface HydratedGithubState {
  pr: LivePrSnapshot;
  protection: BranchProtectionSnapshot | null;
}

export class GitHubStateHydrator {
  constructor(private readonly github: TrustedGitHubPrPort) {}

  async hydrate(input: HydrateInput): Promise<HydratedGithubState> {
    const pr = await this.github.fetchPr(input);
    if (!pr) {
      throw new Error(
        `GitHubStateHydrator: PR ${input.repo}#${input.prNumber} not found (likely closed)`,
      );
    }
    if (pr.state !== 'open') {
      throw new Error(
        `GitHubStateHydrator: PR ${input.repo}#${input.prNumber} state=${pr.state}; cannot merge`,
      );
    }
    const protection = pr.protected
      ? await this.github.fetchBranchProtection({
          repo: input.repo,
          baseBranch: pr.baseBranch,
        })
      : null;
    return { pr, protection };
  }
}

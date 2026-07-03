/**
 * BranchProtectionChecker — T-M9-004, spec §12.10.
 *
 * Verifies the live branch-protection rule still enforces the required
 * checks that justified the merge decision. If the rule was weakened
 * (e.g. required reviews dropped to 0, or `enforce_admins=false`) since
 * the final evaluator ran, the merge is refused — even at admin level.
 *
 * The merge-manager token deliberately lacks the
 * `repo:administration:write` scope so it cannot bypass the rule; this
 * checker confirms that fact structurally by querying the protection
 * rule itself.
 */

import type { BranchProtectionSnapshot } from './github-state-hydrator.js';

export interface BranchProtectionCheckInput {
  protection: BranchProtectionSnapshot | null;
  /** Required reviews floor — defaults to 1. */
  requiredReviewFloor?: number;
}

export interface BranchProtectionCheckResult {
  /** True iff the rule still enforces what cgao expects. */
  ok: boolean;
  reasons: string[];
}

export class BranchProtectionChecker {
  check(input: BranchProtectionCheckInput): BranchProtectionCheckResult {
    const reasons: string[] = [];
    const floor = input.requiredReviewFloor ?? 1;

    if (!input.protection) {
      reasons.push('branch protection rule is missing on the base branch');
      return { ok: false, reasons };
    }
    if (input.protection.requiredReviewCount < floor) {
      reasons.push(`required reviews ${input.protection.requiredReviewCount} < floor ${floor}`);
    }
    if (!input.protection.enforceAdmins) {
      // Spec §12.10: merge-manager must not require an admin override.
      reasons.push('branch protection does not enforce admins (admin override would be required)');
    }
    if (input.protection.requiredCheckCount === 0) {
      reasons.push('branch protection has zero required status checks');
    }
    if (!input.protection.dismissesStaleReviews) {
      reasons.push('branch protection does not dismiss stale reviews on push');
    }
    return { ok: reasons.length === 0, reasons };
  }
}

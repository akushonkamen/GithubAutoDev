/**
 * Merge credential profile — T-M9-004, spec §12.10 / §13.
 *
 * cgao's merge-manager token MUST NOT carry the
 * `repo:administration:write` scope (which would let it bypass branch
 * protection). The orchestrator re-derives the profile from the
 * trusted profile plus an explicit absence assertion so production
 * misconfigurations fail closed.
 *
 * Contract (spec §12.10):
 *
 *   - The merge profile is a TRUSTED profile (it needs GitHub merge API
 *     write access on PRs).
 *   - It MUST NOT carry `repo:administration:write` (the branch
 *     protection bypass scope).
 *   - It MUST NOT carry `admin:org` or any administration scope.
 */

/** Scopes the merge token MUST carry (positive capability). */
export const MERGE_TOKEN_REQUIRED_SCOPES = [
  'repo:pull_requests:write',
  'repo:contents:write',
  'repo:status:write',
] as const;

/** Scopes the merge token MUST NOT carry (administration / bypass). */
export const MERGE_TOKEN_FORBIDDEN_SCOPES = [
  'repo:administration:write',
  'admin:org',
  'admin:org_all',
  'admin:repo_hook',
] as const;

export interface MergeTokenProfile {
  /** Token string (the actual credential). */
  token: string;
  /** Resolved scopes from the GitHub API. */
  scopes: readonly string[];
  /** True iff isTrusted AND no forbidden scope present AND all required scopes present. */
  isMergeManager: boolean;
  /** Why it failed validation (auditor surface). */
  validationErrors: readonly string[];
}

/**
 * Validate a candidate merge token. Returns the profile + validation
 * errors so production can record both outcomes to the audit chain.
 */
export function validateMergeTokenProfile(args: {
  token: string;
  scopes: readonly string[];
  /** True if the underlying credential profile is trusted (spec §13.1). */
  isTrusted: boolean;
}): MergeTokenProfile {
  const errors: string[] = [];
  if (!args.isTrusted) {
    errors.push('merge token must come from a trusted credential profile');
  }
  if (!args.token) {
    errors.push('merge token must be present');
  }
  const forbiddenPresent = MERGE_TOKEN_FORBIDDEN_SCOPES.filter((s) => args.scopes.includes(s));
  if (forbiddenPresent.length > 0) {
    errors.push(
      `merge token carries forbidden scopes: ${forbiddenPresent.join(', ')} (would allow branch-protection bypass)`,
    );
  }
  const missingRequired = MERGE_TOKEN_REQUIRED_SCOPES.filter((s) => !args.scopes.includes(s));
  if (missingRequired.length > 0) {
    errors.push(`merge token missing required scopes: ${missingRequired.join(', ')}`);
  }
  return {
    token: args.token,
    scopes: args.scopes,
    isMergeManager: errors.length === 0,
    validationErrors: errors,
  };
}

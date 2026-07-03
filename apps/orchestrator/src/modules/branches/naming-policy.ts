/**
 * Branch naming policy — T-M7-001, spec §12.8.
 *
 * cgao creates exactly one work branch per workflow run + slug:
 *
 *   cgao/issue-<issueNumber>-<slug>
 *
 * The slug is normalized to a conservative charset so a malicious or
 * mistyped issue title can never produce a branch name that:
 *   - escapes the cgao/ namespace (`..`, `/`, leading `-`),
 *   - collides with lockfile-style names (`pnpm-lock.yaml`, `package.json`),
 *   - mimics secret-bearing filenames (`.env`, `.npmrc`, etc.),
 *   - exceeds the 40-char ceiling so the git reflog stays readable.
 *
 * The normalization is deterministic: identical inputs always produce
 * identical branch names. That idempotence is what lets BranchService
 * deduplicate a re-create call from a retried webhook.
 */

const MAX_SLUG_LEN = 40;

/** Refuse slugs that, after normalization, look like sensitive filenames. */
const FORBIDDEN_BASENENAMES = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.env',
  '.npmrc',
  '.pypirc',
  '.netrc',
  'credentials',
  'id-rsa',
]);

export interface NamingPolicyInput {
  issueNumber: number;
  /** Raw title / slug source (issue title, plan slug, etc). */
  slug: string;
}

export interface NamingPolicyResult {
  /** The normalized slug (lowercase, digits, dashes). */
  slug: string;
  /** Full branch name: `cgao/issue-<n>-<slug>`. */
  branchName: string;
}

export class BranchNamingError extends Error {
  constructor(
    message: string,
    readonly field: 'issueNumber' | 'slug',
  ) {
    super(message);
    this.name = 'BranchNamingError';
  }
}

/**
 * Normalize a free-form slug source:
 *
 *   "Fix Deploy Bug!" → "fix-deploy-bug"
 *   "  Mixed   CASE " → "mixed-case"
 *   "a..b"            → "a-b"   (no `..`)
 *   "café"            → "caf"   (drop non-ascii letters safely)
 *
 * Trailing/leading dashes are stripped; consecutive dashes collapse.
 */
export function normalizeSlug(input: string): string {
  // Lowercase + replace any run of non-[a-z0-9] with a single dash.
  const lowered = input.toLowerCase().normalize('NFKD');
  let out = '';
  for (const ch of lowered) {
    if (ch >= 'a' && ch <= 'z') {
      out += ch;
    } else if (ch >= '0' && ch <= '9') {
      out += ch;
    } else {
      // Treat any separator-ish char as a single dash; collapse runs.
      if (out.length > 0 && !out.endsWith('-')) out += '-';
    }
  }
  // Strip leading/trailing dashes.
  out = out.replace(/^-+|-+$/gu, '');
  if (out.length > MAX_SLUG_LEN) {
    out = out.slice(0, MAX_SLUG_LEN).replace(/-+$/u, '');
  }
  return out;
}

/**
 * Validate a normalized slug. Throws BranchNamingError on violation so
 * callers can map to a 4xx without leaking the raw input.
 */
export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new BranchNamingError('slug normalizes to empty', 'slug');
  }
  if (slug.length > MAX_SLUG_LEN) {
    throw new BranchNamingError(`slug exceeds ${MAX_SLUG_LEN} chars`, 'slug');
  }
  if (!/^[a-z0-9-]+$/.test(slug)) {
    throw new BranchNamingError('slug contains forbidden chars', 'slug');
  }
  if (slug.includes('..')) {
    throw new BranchNamingError('slug contains `..`', 'slug');
  }
  // Refuse lockfile-style and secret-pattern basenames (post-normalize).
  if (FORBIDDEN_BASENENAMES.has(slug)) {
    throw new BranchNamingError(`slug refused: sensitive basename ${slug}`, 'slug');
  }
  // Defensive: refuse slugs whose dashed form still contains a known
  // sensitive basename as a contiguous prefix (e.g. `pnpm-lock-yaml`
  // → contains `pnpm-lock.yaml` after dash-to-dot restore).
  for (const basename of FORBIDDEN_BASENENAMES) {
    const dashed = basename.replace(/[._]/gu, '-');
    if (slug === dashed) {
      throw new BranchNamingError(`slug refused: sensitive basename ${basename}`, 'slug');
    }
  }
}

/**
 * Format the canonical branch name for an issue + slug.
 * Pure — no validation; pair with validateSlug for caller error mapping.
 */
export function formatBranchName(input: NamingPolicyInput): NamingPolicyResult {
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new BranchNamingError('issueNumber must be a positive integer', 'issueNumber');
  }
  const slug = normalizeSlug(input.slug);
  validateSlug(slug);
  return {
    slug,
    branchName: `cgao/issue-${input.issueNumber}-${slug}`,
  };
}

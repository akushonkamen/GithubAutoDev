/**
 * Path write policy — T-M5-005, spec §13.3.
 *
 * Decides whether a proposed write path is allowed under the plan's
 * allowedPaths / forbiddenPaths. Honors glob-style prefixes (the same
 * shape ImplementationTask.allowedPaths uses) and rejects:
 *
 *   - Absolute paths outside the workspace root.
 *   - `..` traversal that escapes the workspace root.
 *   - Symlinks whose resolved target is outside the workspace root
 *     or inside a forbidden prefix.
 *   - Any path that lands inside forbiddenPaths.
 *
 * The policy is PURE: it does not touch the filesystem. Callers pass
 * a pre-resolved absolute path (and optional symlink target) and the
 * policy returns a decision.
 */

export type PolicyDecision = 'allow' | 'POLICY_DENIED';

export interface PolicyCheck {
  decision: PolicyDecision;
  /** Reasons for denial (empty when allowed). */
  reasons: string[];
}

export interface PathWritePolicyOptions {
  /** Absolute path to the workspace root (the read-only checkout). */
  workspaceRoot: string;
  /** Glob-style prefixes the task may write to. */
  allowedPaths: readonly string[];
  /** Glob-style prefixes the task may NOT touch. */
  forbiddenPaths: readonly string[];
}

export class PathWritePolicy {
  constructor(private readonly opts: PathWritePolicyOptions) {}

  /**
   * Decide whether `proposedPath` may be written. `resolvedSymlink`
   * is the real path of the file the symlink points at, if known —
   * used to catch the symlink-escape attack (spec §21).
   */
  isAllowed(proposedPath: string, resolvedSymlink?: string): PolicyCheck {
    const reasons: string[] = [];
    const normalized = normalizePath(proposedPath);

    if (!normalized.startsWith(`${this.opts.workspaceRoot}/`)) {
      reasons.push(
        `path outside workspace root: ${proposedPath} (root=${this.opts.workspaceRoot})`,
      );
    }

    if (hasTraversal(proposedPath)) {
      reasons.push(`path contains '..' traversal: ${proposedPath}`);
    }

    if (resolvedSymlink !== undefined) {
      const symNorm = normalizePath(resolvedSymlink);
      if (!symNorm.startsWith(`${this.opts.workspaceRoot}/`)) {
        reasons.push(`symlink escapes workspace root: ${resolvedSymlink}`);
      } else {
        // Symlink stays inside the workspace, but its target may still
        // land in a forbidden prefix. Check the target's relative path
        // against the forbidden globs.
        const symRel = symNorm.slice(`${this.opts.workspaceRoot}/`.length);
        for (const forbidden of this.opts.forbiddenPaths) {
          if (matchesGlob(symRel, forbidden)) {
            reasons.push(
              `symlink target matches forbidden prefix: ${forbidden} (target=${symRel})`,
            );
          }
        }
      }
    }

    const rel = normalized.startsWith(`${this.opts.workspaceRoot}/`)
      ? normalized.slice(`${this.opts.workspaceRoot}/`.length)
      : normalized;

    for (const forbidden of this.opts.forbiddenPaths) {
      if (matchesGlob(rel, forbidden)) {
        reasons.push(`path matches forbidden prefix: ${forbidden} (rel=${rel})`);
      }
    }

    const allowed = this.opts.allowedPaths.some((p) => matchesGlob(rel, p));
    if (!allowed) {
      reasons.push(`path not in allowedPaths (rel=${rel})`);
    }

    return reasons.length === 0
      ? { decision: 'allow', reasons: [] }
      : { decision: 'POLICY_DENIED', reasons };
  }
}

/**
 * Normalize a path: resolve `.` and `..`, collapse multiple slashes.
 * Does NOT touch the filesystem.
 */
export function normalizePath(p: string): string {
  const isAbs = p.startsWith('/');
  const parts = p.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      // Pop unless we'd escape (for relative paths we leave leading ..)
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (isAbs) {
        // absolute path: .. at root is silently dropped
        continue;
      } else {
        out.push('..');
      }
      continue;
    }
    out.push(part);
  }
  const joined = out.join('/');
  return isAbs ? `/${joined}` : joined;
}

/** True if the path contains a `..` segment that would resolve upward. */
export function hasTraversal(p: string): boolean {
  return p.split('/').includes('..');
}

/**
 * Glob-style match: pattern may end with `/**` to mean "everything
 * under this directory" or be a literal prefix. Bare `**` matches
 * any path.
 */
export function matchesGlob(rel: string, pattern: string): boolean {
  if (pattern === '**') return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return rel === prefix || rel.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith('**')) {
    const prefix = pattern.slice(0, -2);
    return rel.startsWith(prefix);
  }
  return rel === pattern || rel.startsWith(`${pattern}/`);
}

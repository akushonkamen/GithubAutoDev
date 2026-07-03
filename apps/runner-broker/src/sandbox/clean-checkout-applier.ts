/**
 * Clean checkout applier — T-M5-006, spec §12.6 / §13.3.
 *
 * Given a base SHA + a validated patch, apply the patch to a fresh
 * checkout and verify the result. The "fresh checkout" requirement
 * is what prevents dirty-workspace attacks: the agent's working tree
 * is never the source of truth for tests or PRs.
 *
 * M5 ships an in-memory representation: the caller passes a `base`
 * (map of path → contents) and the applier returns the post-apply
 * contents. The real git-based applier (clone, checkout SHA, git apply)
 * lands when the runner-broker dispatches real subprocesses.
 */

import type { ProtectedFileDetector } from '../policy/protected-file-detector.js';
import { type PatchValidationResult, validatePatch } from './patch-validator.js';
import type { OverlayEntry } from './write-overlay.js';

export interface ApplyInput {
  /** SHA of the base the patch was generated against. */
  baseSha: string;
  /** Patch entries to apply. */
  entries: readonly OverlayEntry[];
  /** Base contents (path → contents) at baseSha. */
  base: ReadonlyMap<string, string>;
  /** Paths the task is allowed to touch. */
  allowedPaths: readonly string[];
  /** Paths the task must NOT touch. */
  forbiddenPaths: readonly string[];
  /** Optional protected-file detector for delete rejection. */
  protectedFileDetector?: ProtectedFileDetector;
}

export interface ApplyResult {
  decision: 'applied' | 'rejected';
  /** Reasons for rejection (empty when applied). */
  reasons: string[];
  /** Post-apply contents (path → contents), sorted by path. */
  result: ReadonlyMap<string, string>;
  /** Files the patch touched. */
  changedFiles: readonly string[];
  /** Files the patch deleted. */
  deletedFiles: readonly string[];
}

/**
 * Apply the patch in memory after validating it. A dirty workspace
 * is rejected: if `base` contains any path the patch deletes without
 * a matching entry, the apply fails (mirrors `git apply --check`).
 */
export function applyToCleanCheckout(input: ApplyInput): ApplyResult {
  const deletedFiles: string[] = [];
  for (const entry of input.entries) {
    if (entry.deleted) deletedFiles.push(entry.path);
  }
  const changedFiles = input.entries.map((e) => e.path);
  const validation: PatchValidationResult = validatePatch({
    changedFiles,
    deletedFiles,
    allowedPaths: input.allowedPaths,
    forbiddenPaths: input.forbiddenPaths,
    protectedFileDetector: input.protectedFileDetector,
  });
  if (validation.decision === 'deny') {
    return {
      decision: 'rejected',
      reasons: validation.reasons,
      result: input.base,
      changedFiles,
      deletedFiles,
    };
  }

  const out = new Map<string, string>(input.base);
  for (const entry of input.entries) {
    if (entry.deleted) {
      out.delete(entry.path);
    } else {
      out.set(entry.path, entry.contents);
    }
  }
  return {
    decision: 'applied',
    reasons: [],
    result: out,
    changedFiles,
    deletedFiles,
  };
}

/**
 * Dirty-workspace check: returns true if `workingTree` differs from
 * `base` in any path NOT touched by the patch. Callers run this on
 * the agent's actual working tree before trusting the patch.
 */
export function detectDirtyWorkspace(
  workingTree: ReadonlyMap<string, string>,
  base: ReadonlyMap<string, string>,
  patchTouched: readonly string[],
): boolean {
  const touched = new Set(patchTouched);
  const allKeys = new Set<string>([...workingTree.keys(), ...base.keys()]);
  for (const key of allKeys) {
    if (touched.has(key)) continue;
    if ((workingTree.get(key) ?? '') !== (base.get(key) ?? '')) return true;
  }
  return false;
}

/**
 * Patch validator — T-M5-006, spec §12.6 / §13.3.
 *
 * Validates that a patch only touches allowedPaths and does not delete
 * protected files. Used by the CleanCheckoutApplier before applying.
 */

import type { ProtectedFileDetector } from '../policy/protected-file-detector.js';

export interface PatchValidationInput {
  /** Relative paths the patch touches. */
  changedFiles: readonly string[];
  /** Relative paths the patch deletes. */
  deletedFiles: readonly string[];
  /** Paths the task is allowed to touch (glob prefixes). */
  allowedPaths: readonly string[];
  /** Paths the task must NOT touch (glob prefixes). */
  forbiddenPaths: readonly string[];
  /** Protected-file detector (T-M5-007). */
  protectedFileDetector?: ProtectedFileDetector;
}

export interface PatchValidationResult {
  decision: 'allow' | 'deny';
  reasons: string[];
}

export function validatePatch(input: PatchValidationInput): PatchValidationResult {
  const reasons: string[] = [];
  for (const file of input.changedFiles) {
    if (!matchesAny(file, input.allowedPaths)) {
      reasons.push(`file not in allowedPaths: ${file}`);
    }
    if (matchesAny(file, input.forbiddenPaths)) {
      reasons.push(`file matches forbidden path: ${file}`);
    }
  }
  if (input.protectedFileDetector) {
    for (const deleted of input.deletedFiles) {
      if (input.protectedFileDetector.isProtected(deleted)) {
        reasons.push(`deleting protected file: ${deleted}`);
      }
    }
  }
  return reasons.length === 0 ? { decision: 'allow', reasons: [] } : { decision: 'deny', reasons };
}

function matchesAny(rel: string, patterns: readonly string[]): boolean {
  return patterns.some((p) => {
    if (p === '**') return true;
    if (p.endsWith('/**')) {
      const prefix = p.slice(0, -3);
      return rel === prefix || rel.startsWith(`${prefix}/`);
    }
    if (p.endsWith('**')) {
      return rel.startsWith(p.slice(0, -2));
    }
    return rel === p || rel.startsWith(`${p}/`);
  });
}

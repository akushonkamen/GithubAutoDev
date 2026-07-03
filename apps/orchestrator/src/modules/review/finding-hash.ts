/**
 * Finding hash — T-M8-003, spec §12.9 / §15.
 *
 * `computeFindingHash` produces a stable sha256 over the canonical JSON
 * of the finding's identity fields. Two findings reported with the same
 * (runId, headSha, reviewer class, rule, file, line range, message) share
 * the same hash, which lets the ReviewFindingRepository dedup re-reports
 * from a retried review run.
 *
 * Identity contract (spec §12.9):
 *
 *   - head_sha is part of the hash → the same finding on a new commit
 *     produces a different hash, so a fixed finding cannot silently
 *     "carry over" as the head advances.
 *   - reviewer class ('code' | 'security') is part of the hash → the
 *     code reviewer and the security reviewer cannot collide.
 *   - recommendation / severity are NOT part of the hash; an updated
 *     review that only changes severity upserts onto the existing row.
 */

import { createHash } from 'node:crypto';
import { stableJsonStringify } from '@cgao/schemas';

export type ReviewerClass = 'code' | 'security';

export interface FindingHashInput {
  runId: string;
  headSha: string;
  reviewer: ReviewerClass;
  rule: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  message: string;
}

/**
 * Compute the canonical finding hash. Returns `sha256:<hex>` so the value
 * is self-describing when persisted.
 */
export function computeFindingHash(input: FindingHashInput): string {
  const canonical = stableJsonStringify({
    runId: input.runId,
    headSha: input.headSha,
    reviewer: input.reviewer,
    rule: input.rule,
    file: input.file,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    message: input.message,
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * ReviewResult + ReviewFinding schemas — T-M8-001, spec §12.9 / §13.2.
 *
 * A ReviewRunner emits a ReviewResult: a SHA-bound bundle of findings
 * produced by one reviewer pass over one (headSha, baseSha) diff. The
 * result is persisted as an artifact and the findings are upserted into
 * the review_findings table.
 *
 * Contracts:
 *
 *   - ReviewResult is bound to head_sha + base_sha; the binding hash
 *     covers canonical({ runId, headSha, baseSha, reviewer, findings }).
 *   - Each ReviewFinding carries its own finding_hash so the repository
 *     can dedup across retries.
 *   - The reviewer that produced the result is stamped on every finding
 *     (reviewer class) so the security runner and code runner cannot be
 *     mixed up at the storage layer.
 */

import { z } from 'zod';
import type { ReviewerClass } from './finding-hash.js';

export const reviewerClassSchema = z.enum(['code', 'security']);

export const severitySchema = z.enum(['low', 'medium', 'high', 'critical']);

export const reviewFindingSchema = z.object({
  /** Stable identity hash from computeFindingHash(). */
  findingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  /** Reviewer class that produced this finding. */
  reviewer: reviewerClassSchema,
  /** Rule id (e.g. 'owasp-a01', 'cgao/missing-test'). */
  rule: z.string().min(1),
  /** File path relative to repo root. */
  file: z.string().min(1),
  /** Inclusive start line (1-based). */
  lineStart: z.number().int().nonnegative(),
  /** Inclusive end line (1-based; >= lineStart). */
  lineEnd: z.number().int().nonnegative(),
  /** Short title. */
  title: z.string().min(1),
  /** Longer description of the problem. */
  message: z.string().min(1),
  /** Optional suggested fix. */
  recommendation: z.string().optional(),
  /** Severity (advisory for code reviewer; authoritative for security). */
  severity: severitySchema,
  /**
   * True iff this finding blocks merge until resolved. Only the security
   * reviewer sets blocking=true today; the code reviewer leaves it false.
   */
  blocking: z.boolean().default(false),
});
export type ReviewFinding = z.infer<typeof reviewFindingSchema>;

export const reviewResultSchema = z.object({
  runId: z.string().min(1),
  headSha: z.string().length(40),
  baseSha: z.string().length(40),
  /** Reviewer class that produced this result. */
  reviewer: reviewerClassSchema,
  /** Findings, in the order the reviewer emitted them. */
  findings: z.array(reviewFindingSchema).default([]),
  /** Free-text overall summary (trusted, cgao-authored rendering). */
  summary: z.string().default(''),
  /** Bumping this lets the gate distinguish renderings across releases. */
  reviewerVersion: z.string().min(1),
  /** sha256 over canonical({ runId, headSha, baseSha, reviewer, findings }). */
  bindingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});
export type ReviewResult = z.infer<typeof reviewResultSchema>;

export type { ReviewerClass };

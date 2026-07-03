/**
 * SecurityFinding — T-M8-002, spec §12.9.
 *
 * A SecurityFinding is a ReviewFinding produced by the security reviewer.
 * It extends the base shape with two authoritative fields:
 *
 *   - severity ∈ {'low','medium','high','critical'} — REQUIRED (no default).
 *   - blocking: boolean — when true, blocks merge in M9 (gate aggregation).
 *
 * Severity-floor policy: the security runner refuses to honor an LLM
 * downgrade of a `critical` classification to `low`. The runner computes
 * the floor from the matched rule catalog and clamps the LLM-reported
 * severity UP to the floor, never down.
 */

import { z } from 'zod';
import { reviewFindingSchema, severitySchema } from './review-result.js';

export const securityFindingSchema = reviewFindingSchema.extend({
  reviewer: z.literal('security'),
  /** Severity is authoritative for security findings. */
  severity: severitySchema,
  /** Blocking findings must be resolved before merge. */
  blocking: z.boolean(),
});
export type SecurityFinding = z.infer<typeof securityFindingSchema>;

/**
 * Rule catalog entry. The runner uses `floor` to clamp the LLM-reported
 * severity so a `critical` rule cannot be downgraded to `low`.
 */
export interface SecurityRuleCatalogEntry {
  rule: string;
  /** Minimum severity the runner will accept for this rule. */
  floor: z.infer<typeof severitySchema>;
}

export const SECURITY_RULE_CATALOG: readonly SecurityRuleCatalogEntry[] = [
  { rule: 'secret-in-source', floor: 'high' },
  { rule: 'sql-injection', floor: 'critical' },
  { rule: 'command-injection', floor: 'critical' },
  { rule: 'path-traversal', floor: 'high' },
  { rule: 'auth-bypass', floor: 'critical' },
  { rule: 'weak-crypto', floor: 'high' },
  { rule: 'input-validation-missing', floor: 'medium' },
  { rule: 'payment-data-handling', floor: 'critical' },
];

const RANK: Record<z.infer<typeof severitySchema>, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Clamp `reported` severity up to the rule's floor. Used by the runner
 * so the LLM cannot downgrade a critical finding to low.
 */
export function enforceSeverityFloor(
  rule: string,
  reported: z.infer<typeof severitySchema>,
): z.infer<typeof severitySchema> {
  const entry = SECURITY_RULE_CATALOG.find((e) => e.rule === rule);
  if (!entry) return reported;
  return RANK[reported] < RANK[entry.floor] ? entry.floor : reported;
}

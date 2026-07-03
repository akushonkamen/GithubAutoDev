/**
 * @cgao/audit — Audit hash chain.
 *
 * Per spec §19. Every authoritative action (label set, approval, merge,
 * intake decision) appends a record to `audit_records` whose `hash` chains
 * over `prev_hash`. Tampering with any historical record breaks the chain
 * and is detected by the reconciler (T-M10-001).
 *
 * M0 ships only the pure hashing/chain-verification logic. The DB schema
 * (audit_records table) and the reconciler land with T-M2-007 / T-M10-001.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const auditActionSchema = z.enum([
  'label.set',
  'label.unset',
  'approval.recorded',
  'merge.executed',
  'intake.accept_hint',
  'intake.override_hint',
  'intake.drop',
]);

export type AuditAction = z.infer<typeof auditActionSchema>;

export const auditRecordSchema = z.object({
  /** Monotonic sequence within a repo. */
  seq: z.number().int().nonnegative(),
  repo: z.string().min(1),
  runId: z.string().nullable(),
  action: auditActionSchema,
  /** Free-form structured detail; must not contain secrets (C-IM-14). */
  detail: z.record(z.unknown()),
  /** ISO-8601 timestamp. */
  at: z.string().datetime(),
  /** sha256 over (prev_hash || canonical(this record without hash field)). */
  hash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  prevHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/u)
    .nullable(),
});

export type AuditRecord = z.infer<typeof auditRecordSchema>;

/** Canonical JSON for hashing: keys sorted, no whitespace. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.keys(v as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = (v as Record<string, unknown>)[k];
          return acc;
        }, {});
    }
    return v;
  });
}

/** Compute the hash of a record given the previous record's hash. */
export function computeAuditHash(record: Omit<AuditRecord, 'hash'>): string {
  const payload = canonicalize(record);
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * Verify a chain of audit records. Returns the index of the first broken
 * record, or `null` if the entire chain is intact.
 */
export function verifyAuditChain(records: readonly AuditRecord[]): number | null {
  let prevHash: string | null = null;
  for (let i = 0; i < records.length; i++) {
    const rec = records[i];
    if (!rec) return i;
    if (rec.prevHash !== prevHash) return i;
    const expected = computeAuditHash({ ...rec, hash: undefined } as Omit<AuditRecord, 'hash'>);
    if (expected !== rec.hash) return i;
    prevHash = rec.hash;
  }
  return null;
}

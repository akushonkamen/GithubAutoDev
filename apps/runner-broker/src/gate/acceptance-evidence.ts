/**
 * Acceptance evidence — T-M6-005, spec §12.7 / §12.9.
 *
 * Per spec §12.8: "PR body 只做展示，不作为 gate 证据". The verifier
 * module produces one `AcceptanceCriterionEvidence` record per
 * acceptance criterion declared in the plan, sourced exclusively from
 * gate_results / verification_results artifacts — never from PR body
 * checkboxes.
 *
 * Each evidence record is SHA-bound to its criterion id + the source
 * artifact ref so the chain is auditable.
 */

import { z } from 'zod';

export const acceptanceEvidenceKindSchema = z.enum(['test', 'review', 'manual']);

export type AcceptanceEvidenceKind = z.infer<typeof acceptanceEvidenceKindSchema>;

export const acceptanceCriterionEvidenceSchema = z.object({
  /** Plan-local criterion id (e.g. `acc-1`). */
  criterionId: z.string().min(1),
  kind: acceptanceEvidenceKindSchema,
  evidence: z
    .object({
      /** `sha256:<hex>` ref to the source artifact (gate log / review). */
      logRef: z.string().optional(),
      /** Ref to a structured review-finding artifact, when applicable. */
      findingRef: z.string().optional(),
      /** Free-text note for manual evidence (no untrusted content!). */
      note: z.string().max(2000).optional(),
    })
    .refine((e) => e.logRef !== undefined || e.findingRef !== undefined || e.note !== undefined, {
      message: 'evidence must include at least one of logRef / findingRef / note',
    }),
  /**
   * `sha256:<hex>` binding hash over canonical({ criterionId, kind,
   * evidence }). Tampering with any field changes the digest.
   */
  bindingHash: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
});

export type AcceptanceCriterionEvidence = z.infer<typeof acceptanceCriterionEvidenceSchema>;

/**
 * Plan-side acceptance criterion declaration. The plan emits one of
 * these per checklist item; the verifier pairs each with an evidence
 * record before the run can advance to MERGE.
 */
export interface AcceptanceCriterion {
  /** Plan-local criterion id. */
  id: string;
  /** Human-readable description (display only — never used as evidence). */
  description: string;
  /** Expected evidence kind. */
  kind: AcceptanceEvidenceKind;
}

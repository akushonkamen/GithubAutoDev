/**
 * Handoff artifact schema — T-M4-006, spec §5, §11, §12.6.
 *
 * cgao never lets one agent's full memory bleed into the next. Each
 * stage transition produces a HANDOFF artifact that contains only the
 * minimal, structured context the downstream agent needs. The
 * orchestrator persists handoffs via the Artifact Store; the schema
 * here is the wire format.
 *
 * Contracts (spec §5, §11, §12.6):
 *
 *   - Three handoff kinds:
 *       analysis→plan   (kind = 'analysis_to_plan')
 *       plan→dev        (kind = 'plan_to_dev')
 *       dev→review      (kind = 'dev_to_review')
 *
 *   - The downstream agent reads a handoff via `readHandoff`, which
 *     applies role-based REDACTION. By default, a reviewer does NOT
 *     see the executor's self-defense narrative — they see the patch,
 *     the test logs, and the changed-files list, but not the
 *     free-text "summary" the executor wrote about why its choices
 *     were correct.
 *
 *   - Every handoff is hash-chained to the upstream artifact:
 *       upstream_ref = "artifact://<kind>/<digest>"
 *     and carries its own digest over canonical JSON.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const handoffKindSchema = z.enum(['analysis_to_plan', 'plan_to_dev', 'dev_to_review']);
export type HandoffKind = z.infer<typeof handoffKindSchema>;

const string64 = z.string().length(64);

const testRunSchema = z.object({
  command: z.string().min(1),
  exitCode: z.number().int(),
  logRef: z.string().min(1),
});
export type TestRun = z.infer<typeof testRunSchema>;

/**
 * The "dev → review" handoff carries everything the reviewer needs to
 * decide whether the patch is safe to merge. The executor's free-text
 * narrative is captured separately so the reviewer can be REDACTED
 * from it by default.
 */
export const devToReviewPayloadSchema = z.object({
  baseSha: string64,
  headSha: string64,
  patchSha: z.string().min(1),
  changedFiles: z.array(z.string().min(1)),
  testsRun: z.array(testRunSchema).default([]),
  risks: z.array(z.string().min(1)).default([]),
  /** Executor's self-defense narrative — REDACTED for reviewer by default. */
  executorNarrative: z.string().default(''),
});
export type DevToReviewPayload = z.infer<typeof devToReviewPayloadSchema>;

export const analysisToPlanPayloadSchema = z.object({
  /** RequirementSpec digest this analysis was based on. */
  requirementSpecDigest: string64,
  /** Summary the planner needs to see. */
  summary: z.string().min(1),
  /** Open questions surfaced by analysis (advisory). */
  openQuestions: z.array(z.string().min(1)).default([]),
});
export type AnalysisToPlanPayload = z.infer<typeof analysisToPlanPayloadSchema>;

export const planToDevPayloadSchema = z.object({
  planId: z.string().min(1),
  planSha: string64,
  /** Task ids the dev agent should execute (subset of the plan). */
  taskIds: z.array(z.string().min(1)).min(1),
  /** Allowed/forbidden paths inherited from the plan. */
  allowedPaths: z.array(z.string().min(1)).default([]),
  forbiddenPaths: z.array(z.string().min(1)).default([]),
});
export type PlanToDevPayload = z.infer<typeof planToDevPayloadSchema>;

export const handoffPayloadSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('analysis_to_plan'), data: analysisToPlanPayloadSchema }),
  z.object({ kind: z.literal('plan_to_dev'), data: planToDevPayloadSchema }),
  z.object({ kind: z.literal('dev_to_review'), data: devToReviewPayloadSchema }),
]);
export type HandoffPayload = z.infer<typeof handoffPayloadSchema>;

export const handoffSchema = z.object({
  /** Workflow run id (matches the audit trail). */
  runId: z.string().min(1),
  /** Monotonic generation within the run. */
  generation: z.number().int().nonnegative(),
  kind: handoffKindSchema,
  /** Stage that produced this handoff. */
  fromStage: z.string().min(1),
  /** Stage that should consume it. */
  toStage: z.string().min(1),
  /** Upstream artifact URI ("artifact://requirement-spec/<sha>" etc). */
  upstreamRef: z.string().min(1),
  /** Canonical-JSON sha256 of the payload (excludes handoffSha itself). */
  payloadSha: string64,
  /** sha256 of the full handoff body (for tamper detection). */
  handoffSha: string64,
  /** Discriminated payload. */
  payload: handoffPayloadSchema,
  /** ISO-8601 created_at. */
  createdAt: z.string(),
});
export type Handoff = z.infer<typeof handoffSchema>;

/**
 * Compute sha256 over the canonical JSON of a value (sorted keys, no
 * whitespace, UTF-8). Identical to the plan digest algorithm — kept
 * local to avoid a circular import on the plan module.
 */
function sha256Canonical(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const pairs = keys.map((k) => {
    const v = (value as Record<string, unknown>)[k];
    return `${JSON.stringify(k)}:${stableJsonStringify(v)}`;
  });
  return `{${pairs.join(',')}}`;
}

export interface BuildHandoffInput {
  runId: string;
  generation: number;
  payload: HandoffPayload;
  fromStage: string;
  toStage: string;
  upstreamRef: string;
  now?: Date;
}

/**
 * Assemble a Handoff with both payload_sha and handoff_sha stamped.
 * Pure — caller supplies all fields.
 */
export function buildHandoff(input: BuildHandoffInput): Handoff {
  const now = (input.now ?? new Date()).toISOString();
  // Parse the payload FIRST so default-filled fields (.default([])) are
  // present in the digest — otherwise verifyHandoffPayloadSha() would
  // recompute over the post-parse shape and never match.
  const parsedPayload = handoffPayloadSchema.parse(input.payload);
  const payloadSha = sha256Canonical(parsedPayload);
  const body = {
    createdAt: now,
    fromStage: input.fromStage,
    generation: input.generation,
    kind: parsedPayload.kind,
    payload: parsedPayload,
    payloadSha,
    runId: input.runId,
    toStage: input.toStage,
    upstreamRef: input.upstreamRef,
  };
  const handoffSha = sha256Canonical({
    createdAt: body.createdAt,
    fromStage: body.fromStage,
    generation: body.generation,
    kind: body.kind,
    payloadSha: body.payloadSha,
    runId: body.runId,
    toStage: body.toStage,
    upstreamRef: body.upstreamRef,
  });
  return handoffSchema.parse({ ...body, handoffSha });
}

/**
 * Reader role. Determines which fields are visible to the consuming
 * agent. The reviewer gets a REDACTED view by default; the planner
 * and dev get the full payload.
 *
 *   - planner (consumes analysis_to_plan): full
 *   - dev     (consumes plan_to_dev):      full
 *   - reviewer (consumes dev_to_review):   REDACTED (no executorNarrative)
 */
export type HandoffReaderRole = 'planner' | 'dev' | 'reviewer' | 'auditor';

export interface RedactedField {
  /** JSON path of the redacted field (e.g. 'payload.data.executorNarrative'). */
  path: string;
  /** Why it was redacted. */
  reason: string;
}

export interface ReadHandoffResult {
  /** The (possibly redacted) handoff body. */
  handoff: Handoff;
  /** List of fields that were redacted for this reader. */
  redactions: readonly RedactedField[];
}

/**
 * Read a handoff, applying role-based redaction.
 *
 * Default policy: a reviewer does NOT see payload.data.executorNarrative
 * — it's the executor's self-defense narrative, and the reviewer should
 * form an independent opinion from the patch + tests. The orchestrator
 * can override this via `allowExecutorNarrative` (e.g. for an auditor
 * debugging a regression).
 */
export function readHandoff(args: {
  handoff: Handoff;
  reader: HandoffReaderRole;
  allowExecutorNarrative?: boolean;
}): ReadHandoffResult {
  const redactions: RedactedField[] = [];
  let handoff = args.handoff;

  if (
    handoff.kind === 'dev_to_review' &&
    args.reader === 'reviewer' &&
    !args.allowExecutorNarrative
  ) {
    const narrative = handoff.payload.data.executorNarrative;
    if (narrative && narrative.length > 0) {
      redactions.push({
        path: 'payload.data.executorNarrative',
        reason: 'reviewer-default-redact: executor self-defense narrative hidden',
      });
      handoff = {
        ...handoff,
        payload: {
          ...handoff.payload,
          data: { ...handoff.payload.data, executorNarrative: '[redacted]' },
        },
      };
    }
  }

  return { handoff, redactions };
}

/**
 * Verify a handoff's payloadSha matches a recomputed digest. Used by
 * the orchestrator at stage transitions to catch tampering.
 *
 * Re-parses the payload through the schema first so default-filled
 * fields are normalized to the same shape used at build time.
 */
export function verifyHandoffPayloadSha(handoff: Handoff): boolean {
  const normalized = handoffPayloadSchema.parse(handoff.payload);
  const recomputed = sha256Canonical(normalized);
  return recomputed === handoff.payloadSha;
}

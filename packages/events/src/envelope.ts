/**
 * @cgao/events — CloudEvents-style envelope + topic registry.
 *
 * Per docs/standards/events.md (T-M0-005). Every CGAO event is wrapped in this
 * envelope before hitting the bus. Topic names are kebab-case with dotted
 * subgrouping (e.g. `intake.webhook.lark`, `issue.created`).
 */
import { z } from 'zod';

export const cgaoEventEnvelopeSchema = z.object({
  id: z.string().uuid(),
  source: z.string().min(1),
  type: z
    .string()
    .regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9-]*)+$/u, 'CGAO event type must be dotted kebab-case'),
  time: z.string().datetime(),
  subject: z.string().min(1),
  datacontenttype: z.literal('application/json'),
  data: z.unknown(),
  // SHA-bound trace: hash chain head from spec §19 / T-M2-007
  trace: z.object({
    repo: z.string(),
    run_id: z.string().nullable(),
    prev_hash: z.string().nullable(),
  }),
  // Idempotency: dedup_key is computed by the producer from event-content
  // stable fields; the bus dedups on (source, type, subject, dedup_key)
  // within a 24h window (spec §4.4).
  dedup_key: z.string().min(1),
});

export type CgaoEventEnvelope = z.infer<typeof cgaoEventEnvelopeSchema>;

export type CgaoTopicName =
  // Webhook ingress
  | 'webhook.github'
  // Intake (v3)
  | 'intake.webhook.lark'
  | 'intake.webhook.wecom'
  | 'intake.decision.explicit'
  | 'intake.decision.llm_high_confidence'
  | 'intake.decision.llm_low_confidence'
  | 'intake.decision.rejected'
  | 'intake.decision.dropped'
  | 'intake.issue.create_requested'
  // Issue lifecycle
  | 'issue.created'
  | 'issue.labeled'
  | 'issue.comment.created'
  | 'issue.triage.completed'
  // Workflow run lifecycle
  | 'run.created'
  | 'run.state.changed'
  | 'run.spec.generated'
  | 'run.plan.generated'
  | 'run.plan.approved'
  | 'run.dev.ready'
  | 'run.test.completed'
  | 'run.review.completed'
  | 'run.merge.requested'
  | 'run.merge.completed'
  | 'run.cancelled'
  // Reconciler
  | 'reconciler.drift_detected'
  // Errors
  | 'error.unhandled';

export const CGAO_TOPICS: readonly CgaoTopicName[] = [
  'webhook.github',
  'intake.webhook.lark',
  'intake.webhook.wecom',
  'intake.decision.explicit',
  'intake.decision.llm_high_confidence',
  'intake.decision.llm_low_confidence',
  'intake.decision.rejected',
  'intake.decision.dropped',
  'intake.issue.create_requested',
  'issue.created',
  'issue.labeled',
  'issue.comment.created',
  'issue.triage.completed',
  'run.created',
  'run.state.changed',
  'run.spec.generated',
  'run.plan.generated',
  'run.plan.approved',
  'run.dev.ready',
  'run.test.completed',
  'run.review.completed',
  'run.merge.requested',
  'run.merge.completed',
  'run.cancelled',
  'reconciler.drift_detected',
  'error.unhandled',
] as const;

export function assertTopic(t: string): asserts t is CgaoTopicName {
  if (!CGAO_TOPICS.includes(t as CgaoTopicName)) {
    throw new Error(`Unknown CGAO topic: ${t}`);
  }
}

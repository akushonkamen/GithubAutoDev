import { integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const workflowEvents = pgTable('workflow_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  type: text('type').notNull(),
  source: text('source').notNull(),
  correlationId: text('correlation_id').notNull(),
  generation: integer('generation'),
  issueSnapshotSha: text('issue_snapshot_sha'),
  specSha: text('spec_sha'),
  planSha: text('plan_sha'),
  headSha: text('head_sha'),
  baseSha: text('base_sha'),
  payload: jsonb('payload').notNull(),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp('processed_at', { withTimezone: true }),
  status: text('status').notNull().default('pending'),
  error: text('error'),
});

export type WorkflowEvent = typeof workflowEvents.$inferSelect;
export type NewWorkflowEvent = typeof workflowEvents.$inferInsert;

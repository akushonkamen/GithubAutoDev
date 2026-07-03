import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const policyDecisions = pgTable('policy_decisions', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  policyVersion: text('policy_version').notNull(),
  decision: text('decision').notNull(),
  reason: jsonb('reason').notNull(),
  headSha: text('head_sha'),
  baseSha: text('base_sha'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type PolicyDecision = typeof policyDecisions.$inferSelect;
export type NewPolicyDecision = typeof policyDecisions.$inferInsert;

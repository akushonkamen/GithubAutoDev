import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const gateResults = pgTable('gate_results', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  gateName: text('gate_name').notNull(),
  status: text('status').notNull(),
  headSha: text('head_sha').notNull(),
  baseSha: text('base_sha'),
  evidenceArtifactId: text('evidence_artifact_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type GateResult = typeof gateResults.$inferSelect;
export type NewGateResult = typeof gateResults.$inferInsert;

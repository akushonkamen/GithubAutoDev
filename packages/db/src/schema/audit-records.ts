import { jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

/**
 * Hash-chained audit log — spec §19. Each row's record_hash depends
 * on the previous row's record_hash (linked list). Writes MUST go
 * through AuditChainService so prev-hash is fetched under the same
 * transaction; never insert directly bypassing the chain helper.
 */
export const auditRecords = pgTable('audit_records', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  previousHash: text('previous_hash'),
  recordHash: text('record_hash').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type AuditRecord = typeof auditRecords.$inferSelect;
export type NewAuditRecord = typeof auditRecords.$inferInsert;

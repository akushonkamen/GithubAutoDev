import { boolean, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const reviewFindings = pgTable('review_findings', {
  id: text('id').primaryKey(),
  findingHash: text('finding_hash').notNull(),
  runId: text('run_id').references(() => workflowRuns.id),
  prNumber: integer('pr_number'),
  headSha: text('head_sha').notNull(),
  severity: text('severity').notNull(),
  category: text('category').notNull(),
  filePath: text('file_path'),
  lineNumber: integer('line_number'),
  title: text('title').notNull(),
  description: text('description').notNull(),
  recommendation: text('recommendation'),
  blocking: boolean('blocking').notNull().default(false),
  status: text('status').notNull().default('open'),
  closedBy: text('closed_by'),
  closeReason: text('close_reason'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp('closed_at', { withTimezone: true }),
});

export type ReviewFinding = typeof reviewFindings.$inferSelect;
export type NewReviewFinding = typeof reviewFindings.$inferInsert;

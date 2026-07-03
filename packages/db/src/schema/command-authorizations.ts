import { bigint, boolean, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const commandAuthorizations = pgTable('command_authorizations', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  command: text('command').notNull(),
  actorLogin: text('actor_login').notNull(),
  actorPermission: text('actor_permission').notNull(),
  sourceCommentId: bigint('source_comment_id', { mode: 'number' }).notNull(),
  targetPlanId: text('target_plan_id'),
  targetPlanSha: text('target_plan_sha'),
  authorized: boolean('authorized').notNull(),
  reason: jsonb('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type CommandAuthorization = typeof commandAuthorizations.$inferSelect;
export type NewCommandAuthorization = typeof commandAuthorizations.$inferInsert;

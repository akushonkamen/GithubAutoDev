import { index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const intakeSessions = pgTable(
  'intake_sessions',
  {
    id: text('id').primaryKey(),
    sourceType: text('source_type').notNull(),
    externalId: text('external_id').notNull(),
    contentHash: text('content_hash').notNull(),
    channelId: text('channel_id'),
    threadId: text('thread_id'),
    senderImUserId: text('sender_im_user_id'),
    senderGithubLogin: text('sender_github_login'),
    status: text('status').notNull(),
    createdIssueNumber: integer('created_issue_number'),
    workflowRunId: text('workflow_run_id'),
    dedupKey: text('dedup_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    dedupUniq: uniqueIndex('intake_sessions_dedup_key_uniq').on(t.dedupKey),
    statusIdx: index('idx_intake_sessions_status').on(t.status),
    sourceExtIdx: index('idx_intake_sessions_source_external').on(t.sourceType, t.externalId),
    createdIdx: index('idx_intake_sessions_created_at').on(t.createdAt),
  }),
);

export type IntakeSession = typeof intakeSessions.$inferSelect;
export type NewIntakeSession = typeof intakeSessions.$inferInsert;

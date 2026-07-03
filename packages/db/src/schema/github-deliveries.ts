import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const githubDeliveries = pgTable('github_deliveries', {
  deliveryId: text('delivery_id').primaryKey(),
  eventName: text('event_name').notNull(),
  repoOwner: text('repo_owner'),
  repoName: text('repo_name'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  payloadSha256: text('payload_sha256').notNull(),
  processed: boolean('processed').notNull().default(false),
});

export type GithubDelivery = typeof githubDeliveries.$inferSelect;
export type NewGithubDelivery = typeof githubDeliveries.$inferInsert;

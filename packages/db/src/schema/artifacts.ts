import { bigint, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const artifacts = pgTable('artifacts', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  generation: integer('generation').notNull(),
  kind: text('kind').notNull(),
  classification: text('classification').notNull(),
  uri: text('uri').notNull(),
  sha256: text('sha256').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  producer: text('producer'),
  redactionStatus: text('redaction_status').notNull().default('pending'),
  encryptionKeyId: text('encryption_key_id'),
  accessPolicy: text('access_policy').notNull().default('internal'),
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifactRow = typeof artifacts.$inferInsert;

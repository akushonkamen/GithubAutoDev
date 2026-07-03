import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { intakeSessions } from './intake-sessions.js';

/**
 * Intake messages are PostgreSQL-only — never written to Artifact Store
 * (spec §12.0). Only `intake.decision.*` events produce artifacts.
 */
export const intakeMessages = pgTable('intake_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').references(() => intakeSessions.id),
  role: text('role').notNull(),
  content: text('content').notNull(),
  redactedContentArtifactId: text('redacted_content_artifact_id'),
  receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
});

export type IntakeMessage = typeof intakeMessages.$inferSelect;
export type NewIntakeMessage = typeof intakeMessages.$inferInsert;

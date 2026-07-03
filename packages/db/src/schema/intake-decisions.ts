import { index, jsonb, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { intakeSessions } from './intake-sessions.js';

export const intakeDecisions = pgTable(
  'intake_decisions',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').references(() => intakeSessions.id),
    decision: text('decision').notNull(),
    confidence: numeric('confidence'),
    reason: jsonb('reason').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    sessionIdx: index('idx_intake_decisions_session').on(t.sessionId),
  }),
);

export type IntakeDecision = typeof intakeDecisions.$inferSelect;
export type NewIntakeDecision = typeof intakeDecisions.$inferInsert;

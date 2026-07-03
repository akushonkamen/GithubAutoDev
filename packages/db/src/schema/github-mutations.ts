import { pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const githubMutations = pgTable('github_mutations', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  resourceType: text('resource_type').notNull(),
  resourceId: text('resource_id'),
  mutationKind: text('mutation_kind').notNull(),
  expectedEchoEvent: text('expected_echo_event'),
  githubActor: text('github_actor'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  observedAt: timestamp('observed_at', { withTimezone: true }),
});

export type GithubMutation = typeof githubMutations.$inferSelect;
export type NewGithubMutation = typeof githubMutations.$inferInsert;

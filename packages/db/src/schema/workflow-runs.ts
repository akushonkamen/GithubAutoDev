import { integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const workflowRuns = pgTable('workflow_runs', {
  id: text('id').primaryKey(),
  repoOwner: text('repo_owner').notNull(),
  repoName: text('repo_name').notNull(),
  issueNumber: integer('issue_number'),
  prNumber: integer('pr_number'),
  state: text('state').notNull(),
  riskLevel: text('risk_level').notNull().default('unknown'),
  generation: integer('generation').notNull().default(1),
  currentIssueSnapshotSha: text('current_issue_snapshot_sha'),
  currentSpecId: text('current_spec_id'),
  currentSpecSha: text('current_spec_sha'),
  currentPlanId: text('current_plan_id'),
  currentPlanSha: text('current_plan_sha'),
  currentApprovalId: text('current_approval_id'),
  currentApprovalSha: text('current_approval_sha'),
  currentHeadSha: text('current_head_sha'),
  currentBaseSha: text('current_base_sha'),
  currentModule: text('current_module'),
  currentAttempt: integer('current_attempt').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  lockedBy: text('locked_by'),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  version: integer('version').notNull().default(0),
});

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;

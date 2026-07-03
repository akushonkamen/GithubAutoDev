import { integer, numeric, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { workflowRuns } from './workflow-runs.js';

export const agentRuns = pgTable('agent_runs', {
  id: text('id').primaryKey(),
  runId: text('run_id').references(() => workflowRuns.id),
  taskId: text('task_id'),
  role: text('role').notNull(),
  model: text('model'),
  status: text('status').notNull(),
  workspacePath: text('workspace_path'),
  inputArtifactId: text('input_artifact_id'),
  outputArtifactId: text('output_artifact_id'),
  headSha: text('head_sha'),
  baseSha: text('base_sha'),
  patchSha: text('patch_sha'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  tokenInput: integer('token_input'),
  tokenOutput: integer('token_output'),
  costUsd: numeric('cost_usd'),
});

export type AgentRun = typeof agentRuns.$inferSelect;
export type NewAgentRun = typeof agentRuns.$inferInsert;

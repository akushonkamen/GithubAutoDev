/**
 * @cgao/db — PostgreSQL schema for CGAO (placeholder; full schema lands in T-M2-001).
 *
 * Scope of M0: stub the table registry as a placeholder. Real schema lands
 * in T-M2-001 (workflow_runs, artifacts, audit_records, intake_sessions,
 * intake_messages, intake_decisions, etc.).
 */
export const TABLE_REGISTRY = [
  'workflow_runs',
  'workflow_run_locks',
  'artifacts',
  'audit_records',
  'review_findings',
  'intake_sessions',
  'intake_messages',
  'intake_decisions',
] as const;

export type TableName = (typeof TABLE_REGISTRY)[number];

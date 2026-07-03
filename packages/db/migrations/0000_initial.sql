-- CGAO initial schema (spec §15). T-M2-001.
-- Idempotent: each CREATE TABLE IF NOT EXISTS; indexes likewise.
-- Generation is driven by drizzle-kit metadata in meta/_journal.json.

-- 1. workflow_runs ----------------------------------------------------------
create table if not exists "workflow_runs" (
  "id" text primary key,
  "repo_owner" text not null,
  "repo_name" text not null,
  "issue_number" integer,
  "pr_number" integer,
  "state" text not null,
  "risk_level" text not null default 'unknown',
  "generation" integer not null default 1,
  "current_issue_snapshot_sha" text,
  "current_spec_id" text,
  "current_spec_sha" text,
  "current_plan_id" text,
  "current_plan_sha" text,
  "current_approval_id" text,
  "current_approval_sha" text,
  "current_head_sha" text,
  "current_base_sha" text,
  "current_module" text,
  "current_attempt" integer not null default 0,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now(),
  "locked_by" text,
  "locked_until" timestamptz,
  "version" integer not null default 0
);

-- 2. github_deliveries ------------------------------------------------------
create table if not exists "github_deliveries" (
  "delivery_id" text primary key,
  "event_name" text not null,
  "repo_owner" text,
  "repo_name" text,
  "received_at" timestamptz not null default now(),
  "payload_sha256" text not null,
  "processed" boolean not null default false
);

-- 3. workflow_events --------------------------------------------------------
create table if not exists "workflow_events" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "type" text not null,
  "source" text not null,
  "correlation_id" text not null,
  "generation" integer,
  "issue_snapshot_sha" text,
  "spec_sha" text,
  "plan_sha" text,
  "head_sha" text,
  "base_sha" text,
  "payload" jsonb not null,
  "received_at" timestamptz not null default now(),
  "processed_at" timestamptz,
  "status" text not null default 'pending',
  "error" text
);
create index if not exists "idx_workflow_events_run" on "workflow_events"("run_id");
create index if not exists "idx_workflow_events_status" on "workflow_events"("status");

-- 4. github_mutations -------------------------------------------------------
create table if not exists "github_mutations" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "resource_type" text not null,
  "resource_id" text,
  "mutation_kind" text not null,
  "expected_echo_event" text,
  "github_actor" text,
  "created_at" timestamptz not null default now(),
  "observed_at" timestamptz
);

-- 5. command_authorizations -------------------------------------------------
create table if not exists "command_authorizations" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "command" text not null,
  "actor_login" text not null,
  "actor_permission" text not null,
  "source_comment_id" bigint not null,
  "target_plan_id" text,
  "target_plan_sha" text,
  "authorized" boolean not null,
  "reason" jsonb not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_command_auth_run" on "command_authorizations"("run_id");

-- 6. agent_runs -------------------------------------------------------------
create table if not exists "agent_runs" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "task_id" text,
  "role" text not null,
  "model" text,
  "status" text not null,
  "workspace_path" text,
  "input_artifact_id" text,
  "output_artifact_id" text,
  "head_sha" text,
  "base_sha" text,
  "patch_sha" text,
  "started_at" timestamptz,
  "finished_at" timestamptz,
  "token_input" integer,
  "token_output" integer,
  "cost_usd" numeric
);
create index if not exists "idx_agent_runs_run" on "agent_runs"("run_id");

-- 7. artifacts --------------------------------------------------------------
create table if not exists "artifacts" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "generation" integer not null,
  "kind" text not null,
  "classification" text not null,
  "uri" text not null,
  "sha256" text not null,
  "size_bytes" bigint,
  "producer" text,
  "redaction_status" text not null default 'pending',
  "encryption_key_id" text,
  "access_policy" text not null default 'internal',
  "retention_until" timestamptz,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_artifacts_run" on "artifacts"("run_id");
create index if not exists "idx_artifacts_sha256" on "artifacts"("sha256");
create unique index if not exists "uniq_artifacts_uri" on "artifacts"("uri");

-- 8. gate_results -----------------------------------------------------------
create table if not exists "gate_results" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "gate_name" text not null,
  "status" text not null,
  "head_sha" text not null,
  "base_sha" text,
  "evidence_artifact_id" text,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_gate_results_run" on "gate_results"("run_id");

-- 9. review_findings --------------------------------------------------------
create table if not exists "review_findings" (
  "id" text primary key,
  "finding_hash" text not null,
  "run_id" text references "workflow_runs"("id"),
  "pr_number" integer,
  "head_sha" text not null,
  "severity" text not null,
  "category" text not null,
  "file_path" text,
  "line_number" integer,
  "title" text not null,
  "description" text not null,
  "recommendation" text,
  "blocking" boolean not null default false,
  "status" text not null default 'open',
  "closed_by" text,
  "close_reason" text,
  "created_at" timestamptz not null default now(),
  "closed_at" timestamptz
);
create index if not exists "idx_review_findings_run" on "review_findings"("run_id");
create index if not exists "idx_review_findings_pr" on "review_findings"("pr_number");

-- 10. policy_decisions ------------------------------------------------------
create table if not exists "policy_decisions" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "policy_version" text not null,
  "decision" text not null,
  "reason" jsonb not null,
  "head_sha" text,
  "base_sha" text,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_policy_decisions_run" on "policy_decisions"("run_id");

-- 11. audit_records ---------------------------------------------------------
create table if not exists "audit_records" (
  "id" text primary key,
  "run_id" text references "workflow_runs"("id"),
  "previous_hash" text,
  "record_hash" text not null,
  "kind" text not null,
  "payload" jsonb not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_audit_records_run" on "audit_records"("run_id");
create index if not exists "idx_audit_records_prev" on "audit_records"("previous_hash");

-- 12. intake_sessions -------------------------------------------------------
create table if not exists "intake_sessions" (
  "id" text primary key,
  "source_type" text not null,
  "external_id" text not null,
  "content_hash" text not null,
  "channel_id" text,
  "thread_id" text,
  "sender_im_user_id" text,
  "sender_github_login" text,
  "status" text not null,
  "created_issue_number" integer,
  "workflow_run_id" text,
  "dedup_key" text not null,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create unique index if not exists "intake_sessions_dedup_key_uniq" on "intake_sessions"("dedup_key");
create index if not exists "idx_intake_sessions_status" on "intake_sessions"("status");
create index if not exists "idx_intake_sessions_source_external" on "intake_sessions"("source_type", "external_id");
create index if not exists "idx_intake_sessions_created_at" on "intake_sessions"("created_at");

-- 13. intake_messages -------------------------------------------------------
create table if not exists "intake_messages" (
  "id" text primary key,
  "session_id" text references "intake_sessions"("id"),
  "role" text not null,
  "content" text not null,
  "redacted_content_artifact_id" text,
  "received_at" timestamptz not null default now()
);
create index if not exists "idx_intake_messages_session" on "intake_messages"("session_id");

-- 14. intake_decisions ------------------------------------------------------
create table if not exists "intake_decisions" (
  "id" text primary key,
  "session_id" text references "intake_sessions"("id"),
  "decision" text not null,
  "confidence" numeric,
  "reason" jsonb not null,
  "created_at" timestamptz not null default now()
);
create index if not exists "idx_intake_decisions_session" on "intake_decisions"("session_id");

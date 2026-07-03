/**
 * Migration SQL regression — T-M2-001.
 *
 * Idempotency matters: webhook replays or rollback-then-reapply must
 * not break the migration. Every statement uses IF NOT EXISTS so the
 * script can be replayed against an already-provisioned DB.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const sql = readFileSync(resolve(here, '../../migrations/0000_initial.sql'), 'utf8');

describe('0000_initial.sql (T-M2-001)', () => {
  const requiredTables = [
    'workflow_runs',
    'github_deliveries',
    'workflow_events',
    'github_mutations',
    'command_authorizations',
    'agent_runs',
    'artifacts',
    'gate_results',
    'review_findings',
    'policy_decisions',
    'audit_records',
    'intake_sessions',
    'intake_messages',
    'intake_decisions',
  ];

  it('declares every required table', () => {
    for (const t of requiredTables) {
      expect(sql, `create table ${t}`).toMatch(
        new RegExp(`create table if not exists "${t}"`, 'u'),
      );
    }
  });

  it('is idempotent — every CREATE uses IF NOT EXISTS', () => {
    const statements = sql
      .split(/;\s*/u)
      .map((s) => s.trim())
      .filter((s) => /^create\s/u.test(s));
    for (const stmt of statements) {
      expect(stmt, stmt).toMatch(/if not exists/u);
    }
  });

  it('declares required unique indexes (dedup_key + artifacts.uri)', () => {
    expect(sql).toMatch(/intake_sessions_dedup_key_uniq/u);
    expect(sql).toMatch(/uniq_artifacts_uri/u);
  });

  it('declares audit_records hash-chain helper indexes', () => {
    expect(sql).toMatch(/idx_audit_records_prev/u);
    expect(sql).toMatch(/"previous_hash"/u);
  });

  it('references workflow_runs(id) as foreign key from dependent tables', () => {
    const fks = [
      'workflow_events',
      'github_mutations',
      'command_authorizations',
      'agent_runs',
      'artifacts',
      'gate_results',
      'review_findings',
      'policy_decisions',
      'audit_records',
    ];
    for (const t of fks) {
      expect(sql, `${t} -> workflow_runs(id)`).toMatch(
        new RegExp(`"${t}"\\s*\\([\\s\\S]*?references\\s*"workflow_runs"\\("id"\\)`, 'u'),
      );
    }
  });
});

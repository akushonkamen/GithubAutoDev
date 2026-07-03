/**
 * DB package smoke test.
 *
 * Real schema (drizzle tables) lands in T-M2-001. For M0 we lock the
 * table-name registry as a contract: any name added here is a table
 * the orchestrator / reconciler / intake modules will depend on, so
 * additions must be deliberate.
 */

import { describe, expect, it } from 'vitest';
import { TABLE_REGISTRY } from '../index.js';

describe('@cgao/db table registry', () => {
  it('covers all CGAO authoritative state surfaces', () => {
    expect(TABLE_REGISTRY).toContain('workflow_runs');
    expect(TABLE_REGISTRY).toContain('workflow_run_locks');
    expect(TABLE_REGISTRY).toContain('artifacts');
    expect(TABLE_REGISTRY).toContain('audit_records');
    expect(TABLE_REGISTRY).toContain('review_findings');
    expect(TABLE_REGISTRY).toContain('intake_sessions');
    expect(TABLE_REGISTRY).toContain('intake_messages');
    expect(TABLE_REGISTRY).toContain('intake_decisions');
  });

  it('has no duplicate names', () => {
    const seen = new Set<string>();
    for (const name of TABLE_REGISTRY) {
      expect(seen.has(name), `dup ${name}`).toBe(false);
      seen.add(name);
    }
  });

  it('uses snake_case singular-ish naming', () => {
    for (const name of TABLE_REGISTRY) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });
});

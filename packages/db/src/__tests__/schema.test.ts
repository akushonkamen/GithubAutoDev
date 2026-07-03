/**
 * Schema regression — T-M2-001.
 *
 * Locks the drizzle table registry so any future rename/add/remove
 * is a deliberate act. Each table handle here is a contract that
 * downstream repository / orchestrator code depends on.
 */

import { describe, expect, it } from 'vitest';
import {
  agentRuns,
  artifacts,
  auditRecords,
  commandAuthorizations,
  gateResults,
  githubDeliveries,
  githubMutations,
  intakeDecisions,
  intakeMessages,
  intakeSessions,
  policyDecisions,
  reviewFindings,
  workflowEvents,
  workflowRuns,
} from '../index.js';

const HANDLES = {
  workflowRuns,
  githubDeliveries,
  workflowEvents,
  githubMutations,
  commandAuthorizations,
  agentRuns,
  artifacts,
  gateResults,
  reviewFindings,
  policyDecisions,
  auditRecords,
  intakeSessions,
  intakeMessages,
  intakeDecisions,
} as const;

const EXPECTED_NAMES: Record<keyof typeof HANDLES, string> = {
  workflowRuns: 'workflow_runs',
  githubDeliveries: 'github_deliveries',
  workflowEvents: 'workflow_events',
  githubMutations: 'github_mutations',
  commandAuthorizations: 'command_authorizations',
  agentRuns: 'agent_runs',
  artifacts: 'artifacts',
  gateResults: 'gate_results',
  reviewFindings: 'review_findings',
  policyDecisions: 'policy_decisions',
  auditRecords: 'audit_records',
  intakeSessions: 'intake_sessions',
  intakeMessages: 'intake_messages',
  intakeDecisions: 'intake_decisions',
};

describe('@cgao/db schema registry (T-M2-001)', () => {
  it('exports every required table handle', () => {
    for (const [name, handle] of Object.entries(HANDLES)) {
      expect(handle, `${name} must be defined`).toBeDefined();
    }
  });

  it('declares every spec §15 table with the expected name', () => {
    const lookup = (h: unknown): string | undefined =>
      (h as Record<symbol, string>)[Symbol.for('drizzle:Name') as unknown as symbol];
    for (const [key, expected] of Object.entries(EXPECTED_NAMES)) {
      const handle = HANDLES[key as keyof typeof HANDLES];
      expect(lookup(handle), `${key} table name`).toBe(expected);
    }
  });

  it('uses snake_case naming only', () => {
    for (const expected of Object.values(EXPECTED_NAMES)) {
      expect(expected).toMatch(/^[a-z][a-z0-9_]*$/u);
    }
  });
});

/**
 * Postgres-backed repositories barrel — Plan B Phase 1.
 *
 * Each Postgres*Repository mirrors its InMemory counterpart's interface.
 * Tests that need a real database construct one per test via pg-mem; the
 * orchestrator wires a single instance via buildRuntime().
 */

export { PostgresWorkflowRunRepository, PostgresRunLock } from './workflow-run-repo.js';
export { PostgresReviewFindingRepository } from './review-finding-repo.js';

/**
 * @cgao/dashboard — read-only operator dashboard (T-M11-004, spec §19).
 *
 * Hono app exposing 4 pages:
 *   - GET /           run list (active, blocked, recently merged)
 *   - GET /runs/:id   run detail (gate status, fingerprint, decision)
 *   - GET /costs      cost summary (budget consumed per repo)
 *   - GET /healthz    liveness probe
 *
 * Auth: DASHBOARD_TOKEN env (bearer). All routes except /healthz
 * require `Authorization: Bearer <token>`.
 *
 * Read-only: never invokes a mutation against the orchestrator. Reads
 * from @cgao/db (read-only replica role).
 */

export { createDashboardApp } from './server.js';
export type {
  DashboardDeps,
  DashboardRunSummary,
  DashboardRunDetail,
  DashboardCostRow,
} from './server.js';

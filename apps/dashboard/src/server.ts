/**
 * Dashboard Hono app — T-M11-004, spec §19.
 *
 * Routes:
 *   - GET /healthz              (unauthenticated liveness probe)
 *   - GET /                     (run list, requires bearer)
 *   - GET /runs/:id             (run detail, requires bearer)
 *   - GET /costs                (cost summary, requires bearer)
 *
 * Auth: DASHBOARD_TOKEN env. All non-health routes require
 * `Authorization: Bearer <token>`. The bearer check is fail-closed
 * when the env is unset (production: ops sets the token; in tests we
 * inject it via DashboardDeps.token).
 *
 * Read-only: handlers never call a mutating method on the deps. The
 * dashboard's role is observability only — operators confirm a run is
 * blocked, look at the failure fingerprint, then act via the
 * orchestrator (separate surface, separate token).
 */

import { Hono } from 'hono';
import { renderCosts, renderRunDetail, renderRunList } from './views/templates.js';

export interface DashboardRunSummary {
  id: string;
  repo: string;
  state: string;
  riskLevel: string | null;
  updatedAt: string;
}

export interface DashboardRunDetail {
  id: string;
  repo: string;
  state: string;
  riskLevel: string | null;
  generation: number;
  currentAttempt: number;
  gateStatus: string | null;
  fingerprint: string | null;
  mergeDecision: string | null;
  updatedAt: string;
}

export interface DashboardCostRow {
  repo: string;
  consumed: number;
  limit: number;
  percent: number;
}

/**
 * Read-only data sources the dashboard consults. Production wires the
 * @cgao/db repos; tests wire fakes that return canned data.
 */
export interface DashboardDeps {
  /** Bearer token; when undefined the dashboard refuses all authed routes. */
  token: string | (() => string);
  listRuns(): Promise<readonly DashboardRunSummary[]>;
  getRun(id: string): Promise<DashboardRunDetail | null>;
  listCosts(): Promise<readonly DashboardCostRow[]>;
}

export function createDashboardApp(deps: DashboardDeps): Hono {
  const app = new Hono();

  app.get('/healthz', (c) => c.json({ status: 'ok', service: 'cgao-dashboard', version: '0.0.0' }));

  app.use('/', async (c, next) => {
    const ok = await checkBearer(c, deps);
    if (!ok) return c.text('unauthorized\n', 401);
    await next();
  });
  app.use('/runs/:id', async (c, next) => {
    const ok = await checkBearer(c, deps);
    if (!ok) return c.text('unauthorized\n', 401);
    await next();
  });
  app.use('/costs', async (c, next) => {
    const ok = await checkBearer(c, deps);
    if (!ok) return c.text('unauthorized\n', 401);
    await next();
  });

  app.get('/', async (c) => {
    const runs = await deps.listRuns();
    return c.html(renderRunList(runs));
  });

  app.get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await deps.getRun(id);
    if (!run) return c.text('not found\n', 404);
    return c.html(renderRunDetail(run));
  });

  app.get('/costs', async (c) => {
    const rows = await deps.listCosts();
    return c.html(renderCosts(rows));
  });

  return app;
}

async function checkBearer(
  c: { req: { header: (n: string) => string | undefined } },
  deps: DashboardDeps,
): Promise<boolean> {
  const expected = typeof deps.token === 'function' ? deps.token() : deps.token;
  if (!expected) return false;
  const auth = c.req.header('authorization');
  if (!auth) return false;
  const match = /^Bearer\s+(.+)$/u.exec(auth);
  if (!match) return false;
  const got = match[1];
  if (!got) return false;
  // Constant-time compare.
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) {
    const a = got.charCodeAt(i);
    const b = expected.charCodeAt(i);
    diff |= a ^ b;
  }
  return diff === 0;
}

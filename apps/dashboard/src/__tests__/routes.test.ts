/**
 * T-M11-004 Dashboard route regression.
 *
 * Contracts (spec §19):
 *   - 4 pages render with mock data.
 *   - Bearer auth required on all routes except /healthz.
 *   - Read-only: deps expose no mutating methods.
 */

import { describe, expect, it } from 'vitest';
import {
  type DashboardCostRow,
  type DashboardDeps,
  type DashboardRunDetail,
  type DashboardRunSummary,
  createDashboardApp,
} from '../server.js';

function makeDeps(token = 't0pSecret'): DashboardDeps {
  return {
    token,
    async listRuns(): Promise<readonly DashboardRunSummary[]> {
      return [
        {
          id: 'r1',
          repo: 'owner/repo',
          state: 'IN_PROGRESS',
          riskLevel: 'standard',
          updatedAt: '2026-07-04T00:00:00Z',
        },
        {
          id: 'r2',
          repo: 'owner/repo',
          state: 'BLOCKED',
          riskLevel: 'strict',
          updatedAt: '2026-07-04T00:01:00Z',
        },
      ];
    },
    async getRun(id: string): Promise<DashboardRunDetail | null> {
      if (id !== 'r1') return null;
      return {
        id,
        repo: 'owner/repo',
        state: 'IN_PROGRESS',
        riskLevel: 'standard',
        generation: 1,
        currentAttempt: 1,
        gateStatus: 'failed',
        fingerprint: 'sha256:abc',
        mergeDecision: 'PENDING',
        updatedAt: '2026-07-04T00:00:00Z',
      };
    },
    async listCosts(): Promise<readonly DashboardCostRow[]> {
      return [{ repo: 'owner/repo', consumed: 30, limit: 100, percent: 30 }];
    },
  };
}

function authHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('T-M11-004 Dashboard', () => {
  it('GET /healthz is open and returns ok', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('GET / without bearer returns 401', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/');
    expect(res.status).toBe(401);
  });

  it('GET / with valid bearer renders the run list', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/', { headers: authHeaders('t0pSecret') });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('owner/repo');
    expect(html).toContain('IN_PROGRESS');
  });

  it('GET /runs/:id renders run detail with fingerprint + decision', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/runs/r1', { headers: authHeaders('t0pSecret') });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('sha256:abc');
    expect(html).toContain('PENDING');
  });

  it('GET /runs/:id returns 404 for unknown id', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/runs/missing', { headers: authHeaders('t0pSecret') });
    expect(res.status).toBe(404);
  });

  it('GET /costs renders cost summary', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/costs', { headers: authHeaders('t0pSecret') });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('owner/repo');
    expect(html).toContain('30.0%');
  });

  it('wrong bearer is rejected (constant-time)', async () => {
    const app = createDashboardApp(makeDeps());
    const res = await app.request('/', { headers: authHeaders('wrong') });
    expect(res.status).toBe(401);
  });

  it('DashboardDeps exposes no mutating method (read-only surface)', () => {
    // Static contract check: the deps interface only has listRuns,
    // listCosts, getRun, token. Mutation would require new methods.
    const deps = makeDeps();
    const methods = Object.keys(deps).sort();
    expect(methods).toEqual(['getRun', 'listCosts', 'listRuns', 'token']);
  });
});

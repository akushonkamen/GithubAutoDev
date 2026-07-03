/**
 * T-M10-004 BudgetService — per-(repo,kind,hour) agent run limit.
 */

import { InMemoryBudgetLedgerRepository } from '@cgao/db';
import { describe, expect, it } from 'vitest';
import { BudgetService } from '../budget-service.js';

describe('T-M10-004 BudgetService', () => {
  it('allows consumption below the per-repo hourly limit', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const svc = new BudgetService(ledger, { perRepoPerHour: 5 });
    const r1 = await svc.consume({
      repo: 'cgao/test',
      actor: 'alice',
      kind: 'agent_run',
      units: 2,
    });
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(3);
    const r2 = await svc.consume({
      repo: 'cgao/test',
      actor: 'alice',
      kind: 'agent_run',
      units: 3,
    });
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
  });

  it('refuses consumption that would exceed the limit', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const svc = new BudgetService(ledger, { perRepoPerHour: 5 });
    await svc.consume({ repo: 'cgao/test', actor: 'alice', kind: 'agent_run', units: 5 });
    const r = await svc.consume({ repo: 'cgao/test', actor: 'alice', kind: 'agent_run', units: 1 });
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
    expect(r.limit).toBe(5);
  });

  it('honors per-repo overrides', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const overrides = new Map([['cgao/big', 100]]);
    const svc = new BudgetService(ledger, { perRepoPerHour: 5, repoOverrides: overrides });
    const r = await svc.consume({
      repo: 'cgao/big',
      actor: 'alice',
      kind: 'agent_run',
      units: 50,
    });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(100);
  });

  it('buckets are isolated per kind', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const svc = new BudgetService(ledger, { perRepoPerHour: 5 });
    await svc.consume({ repo: 'cgao/test', actor: 'alice', kind: 'agent_run', units: 5 });
    const r = await svc.consume({
      repo: 'cgao/test',
      actor: 'alice',
      kind: 'webhook',
      units: 1,
    });
    expect(r.allowed).toBe(true);
  });
});

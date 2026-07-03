/**
 * T-M10-004 ActorQuotaService — external actor daily trigger cap.
 */

import { InMemoryBudgetLedgerRepository } from '@cgao/db';
import { InMemoryEventBus } from '@cgao/eventbus';
import { describe, expect, it } from 'vitest';
import { ActorQuotaService } from '../actor-quota-service.js';

describe('T-M10-004 ActorQuotaService', () => {
  it('allows triggers up to the daily cap', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const bus = new InMemoryEventBus();
    const svc = new ActorQuotaService(ledger, bus, { perActorPerDay: 3 });
    expect((await svc.consume({ actor: 'alice', repo: 'cgao/test', runId: 'r1' })).allowed).toBe(
      true,
    );
    expect((await svc.consume({ actor: 'alice', repo: 'cgao/test', runId: 'r2' })).allowed).toBe(
      true,
    );
    expect((await svc.consume({ actor: 'alice', repo: 'cgao/test', runId: 'r3' })).allowed).toBe(
      true,
    );
  });

  it('refuses the 4th trigger and emits budget.exhausted', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const bus = new InMemoryEventBus();
    const seen: string[] = [];
    bus.subscribe('budget.exhausted', (m) => {
      seen.push((m.payload as { runId: string }).runId);
    });
    const svc = new ActorQuotaService(ledger, bus, { perActorPerDay: 3 });
    for (let i = 0; i < 3; i++) {
      await svc.consume({ actor: 'bob', repo: 'cgao/test', runId: `r${i}` });
    }
    const refused = await svc.consume({
      actor: 'bob',
      repo: 'cgao/test',
      runId: 'r_over',
    });
    expect(refused.allowed).toBe(false);
    expect(refused.used).toBe(3);
    expect(seen).toContain('r_over');
  });

  it('honors per-actor overrides', async () => {
    const ledger = new InMemoryBudgetLedgerRepository();
    const bus = new InMemoryEventBus();
    const overrides = new Map([['vip', 1000]]);
    const svc = new ActorQuotaService(ledger, bus, {
      perActorPerDay: 1,
      actorOverrides: overrides,
    });
    const r = await svc.consume({ actor: 'vip', repo: 'cgao/test', runId: 'r1' });
    expect(r.allowed).toBe(true);
    expect(r.limit).toBe(1000);
  });
});

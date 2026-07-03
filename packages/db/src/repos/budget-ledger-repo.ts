/**
 * BudgetLedgerRepository — T-M10-004, spec §12.11 / §18.
 *
 * Minimal counter repository. The in-memory implementation is the
 * unit-test / startup-mode adapter; a Postgres adapter will UPSERT on
 * (repo, kind, hour_id) using ON CONFLICT ... DO UPDATE SET
 * units = budget_ledger.units + EXCLUDED.units.
 */

import type { BudgetActorQuotaRow, BudgetLedgerRow } from '../schema/budget-ledger.js';

export interface ConsumeInput {
  repo: string;
  kind: string;
  hourId: string;
  units: number;
}

export interface QuotaConsumeInput {
  actor: string;
  dayId: string;
  triggers: number;
}

export interface BudgetLedgerRepository {
  consume(input: ConsumeInput): Promise<{ total: number }>;
  getHour(repo: string, kind: string, hourId: string): Promise<number>;
  consumeQuota(input: QuotaConsumeInput): Promise<{ total: number }>;
  getQuotaDay(actor: string, dayId: string): Promise<number>;
}

export class InMemoryBudgetLedgerRepository implements BudgetLedgerRepository {
  private readonly ledger = new Map<string, BudgetLedgerRow>();
  private readonly quota = new Map<string, BudgetActorQuotaRow>();

  async consume(input: ConsumeInput): Promise<{ total: number }> {
    const key = `${input.repo}|${input.kind}|${input.hourId}`;
    const row = this.ledger.get(key);
    const next = (row?.units ?? 0) + input.units;
    this.ledger.set(key, {
      repo: input.repo,
      kind: input.kind,
      hourId: input.hourId,
      units: next,
      updatedAt: new Date(),
    });
    return { total: next };
  }

  async getHour(repo: string, kind: string, hourId: string): Promise<number> {
    return this.ledger.get(`${repo}|${kind}|${hourId}`)?.units ?? 0;
  }

  async consumeQuota(input: QuotaConsumeInput): Promise<{ total: number }> {
    const key = `${input.actor}|${input.dayId}`;
    const row = this.quota.get(key);
    const next = (row?.triggers ?? 0) + input.triggers;
    this.quota.set(key, {
      actor: input.actor,
      dayId: input.dayId,
      triggers: next,
      updatedAt: new Date(),
    });
    return { total: next };
  }

  async getQuotaDay(actor: string, dayId: string): Promise<number> {
    return this.quota.get(`${actor}|${dayId}`)?.triggers ?? 0;
  }
}

/** Format a Date as the ISO hour bucket 'YYYY-MM-DDTHH' (UTC). */
export function hourBucket(at: Date): string {
  const iso = at.toISOString(); // YYYY-MM-DDTHH:mm:ss.sssZ
  return iso.slice(0, 13); // 'YYYY-MM-DDTHH'
}

/** Format a Date as the ISO day bucket 'YYYY-MM-DD' (UTC). */
export function dayBucket(at: Date): string {
  return at.toISOString().slice(0, 10);
}

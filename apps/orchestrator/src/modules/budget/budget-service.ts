/**
 * BudgetService — T-M10-004, spec §12.11 / §18 / §19.
 *
 * Per-repo per-hour agent run limit. consume() is called before any
 * unit-costing operation (agent run, webhook fan-out, LLM token spend).
 *
 * Returns { allowed, remaining } so callers can short-circuit the
 * workflow_run state machine into WAITING_BUDGET_APPROVAL when allowed
 * is false (the actor-quota path emits the bus event; this service
 * only enforces).
 *
 * Hard rule: consume() MUST be the single point of enforcement; callers
 * MUST NOT also check counters themselves.
 */

import type { BudgetLedgerRepository } from '@cgao/db';
import { dayBucket, hourBucket } from '@cgao/db';

export interface BudgetLimits {
  /** Max units per (repo, kind, hour). Default per-repo hourly agent limit. */
  readonly perRepoPerHour: number;
  /** Optional override per repo. Keyed by repo. */
  readonly repoOverrides?: ReadonlyMap<string, number>;
}

export interface ConsumeInput {
  repo: string;
  actor: string;
  /** Spend kind: 'agent_run' | 'webhook' | 'llm_token'. */
  kind: string;
  units: number;
}

export interface ConsumeResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  used: number;
}

export class BudgetService {
  constructor(
    private readonly ledger: BudgetLedgerRepository,
    private readonly limits: BudgetLimits,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(input: ConsumeInput): Promise<ConsumeResult> {
    const at = this.now();
    const hourId = hourBucket(at);
    const limit = this.limits.repoOverrides?.get(input.repo) ?? this.limits.perRepoPerHour;
    const prior = await this.ledger.getHour(input.repo, input.kind, hourId);
    if (prior + input.units > limit) {
      return { allowed: false, remaining: Math.max(0, limit - prior), limit, used: prior };
    }
    const { total } = await this.ledger.consume({
      repo: input.repo,
      kind: input.kind,
      hourId,
      units: input.units,
    });
    return { allowed: true, remaining: Math.max(0, limit - total), limit, used: total };
  }
}

export { dayBucket, hourBucket };

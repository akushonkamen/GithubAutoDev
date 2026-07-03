/**
 * ActorQuotaService — T-M10-004, spec §12.11 / §18 / §19.
 *
 * External actor daily trigger cap. Each (actor, day) pair has a cap;
 * once the cap is hit, every subsequent trigger for that actor in the
 * same day is refused and a `budget.exhausted` event is emitted on the
 * bus so downstream consumers (workflow_run state machine) can park the
 * run in WAITING_BUDGET_APPROVAL.
 */

import type { BudgetLedgerRepository } from '@cgao/db';
import type { EventBus } from '@cgao/eventbus';

export interface ActorQuotaConfig {
  /** Daily trigger cap per external actor. */
  readonly perActorPerDay: number;
  /** Optional override keyed by actor login. */
  readonly actorOverrides?: ReadonlyMap<string, number>;
}

export interface QuotaInput {
  actor: string;
  repo: string;
  runId: string;
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number;
}

export class ActorQuotaService {
  constructor(
    private readonly ledger: BudgetLedgerRepository,
    private readonly bus: EventBus,
    private readonly config: ActorQuotaConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async consume(input: QuotaInput): Promise<QuotaResult> {
    const dayId = this.now().toISOString().slice(0, 10);
    const limit = this.config.actorOverrides?.get(input.actor) ?? this.config.perActorPerDay;
    const prior = await this.ledger.getQuotaDay(input.actor, dayId);
    if (prior + 1 > limit) {
      await this.bus.publish({
        topic: 'budget.exhausted',
        payload: {
          actor: input.actor,
          repo: input.repo,
          runId: input.runId,
          dayId,
          used: prior,
          limit,
          nextState: 'WAITING_BUDGET_APPROVAL',
        },
        headers: { 'x-cgao-actor': input.actor, 'x-cgao-run': input.runId },
        traceId: null,
      });
      return { allowed: false, used: prior, limit };
    }
    const { total } = await this.ledger.consumeQuota({
      actor: input.actor,
      dayId,
      triggers: 1,
    });
    return { allowed: true, used: total, limit };
  }
}

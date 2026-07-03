/**
 * budget_ledger + budget_quota — T-M10-004, spec §12.11 / §18.
 *
 * Two tables back the cost / rate-limit control surface:
 *
 *   budget_ledger: per-(repo, kind, hour) counter rows. The budget
 *     service UPSERTs a row keyed on (repo, kind, hour_id) every time
 *     BudgetService.consume() runs. The row's `units` value is the
 *     sum of all consumption in that hour.
 *
 *   budget_actor_quota: per-(actor, day) counter rows. Used by the
 *     external actor daily trigger cap (ActorQuotaService).
 *
 * Both tables are append-mostly; the budget service never deletes
 * historical rows (audit + ops reporting depend on them).
 */

import { integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

export const budgetLedger = pgTable(
  'budget_ledger',
  {
    repo: text('repo').notNull(),
    /** Consumption bucket kind: 'agent_run' | 'webhook' | 'llm_token'. */
    kind: text('kind').notNull(),
    /** Hour bucket id: ISO date 'YYYY-MM-DDTHH' (UTC, hour-precision). */
    hourId: text('hour_id').notNull(),
    units: integer('units').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('budget_ledger_uniq').on(t.repo, t.kind, t.hourId),
  }),
);

export const budgetActorQuota = pgTable(
  'budget_actor_quota',
  {
    actor: text('actor').notNull(),
    /** Day bucket id: 'YYYY-MM-DD' (UTC). */
    dayId: text('day_id').notNull(),
    /** Number of triggers consumed. */
    triggers: integer('triggers').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniq: uniqueIndex('budget_actor_quota_uniq').on(t.actor, t.dayId),
  }),
);

export type BudgetLedgerRow = typeof budgetLedger.$inferSelect;
export type NewBudgetLedgerRow = typeof budgetLedger.$inferInsert;
export type BudgetActorQuotaRow = typeof budgetActorQuota.$inferSelect;
export type NewBudgetActorQuotaRow = typeof budgetActorQuota.$inferInsert;

/**
 * Origin suppression store — T-M1-004, spec §12.1 / §14.2 / §15.
 *
 * Every authoritative mutation CGAO performs (status comment post,
 * label sync) appends a row to `github_mutations`. When a webhook
 * fires shortly after, we check whether the actor + action matches
 * one of our recent mutations; if so, the event is tagged
 * `origin=observed` and the orchestrator skips retriage.
 *
 * M1 ships the in-memory store. M2 swaps in the `github_mutations`
 * table.
 */

export interface MutationRecord {
  /** github login of the actor (always the CGAO bot). */
  actor: string;
  /** GitHub event/action pair, e.g. `issue_comment.created`. */
  eventType: string;
  /** Stable subject from the CloudEvents envelope. */
  subject: string;
  /** Mutation content sha (so a re-edit doesn't suppress the new payload). */
  contentHash: string;
  at: number;
}

export interface SuppressionStore {
  record(m: Omit<MutationRecord, 'at'> & Partial<Pick<MutationRecord, 'at'>>): Promise<void>;
  /** Returns the matching mutation if any recent one explains `subject`. */
  match(input: {
    actor: string;
    eventType: string;
    subject: string;
    contentHash: string;
  }): Promise<MutationRecord | null>;
}

const SUPPRESSION_WINDOW_MS = 5 * 60 * 1000;

export class InMemorySuppressionStore implements SuppressionStore {
  private readonly records: MutationRecord[] = [];
  private readonly windowMs: number;

  constructor(windowMs: number = SUPPRESSION_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  async record(m: Omit<MutationRecord, 'at'> & Partial<Pick<MutationRecord, 'at'>>): Promise<void> {
    this.records.push({ ...m, at: m.at ?? Date.now() });
    this.gc();
  }

  async match(input: {
    actor: string;
    eventType: string;
    subject: string;
    contentHash: string;
  }): Promise<MutationRecord | null> {
    this.gc();
    return (
      this.records.find(
        (r) =>
          r.actor === input.actor &&
          r.eventType === input.eventType &&
          r.subject === input.subject &&
          r.contentHash === input.contentHash,
      ) ?? null
    );
  }

  private gc(): void {
    const cutoff = Date.now() - this.windowMs;
    while (this.records.length > 0 && this.records[0] && this.records[0].at < cutoff) {
      this.records.shift();
    }
  }

  /** Test hook — wipe all records so `__internals.__reset()` works. */
  clearForTests(): void {
    this.records.length = 0;
  }
}

/**
 * Delivery dedup store — T-M1-002, spec §12.1 / §15.
 *
 * In-memory implementation for M1; M2 swaps in a Postgres-backed
 * `github_deliveries` table behind the same interface.
 *
 * Spec calls for a 24h window; constant lives here as the single
 * source of truth so tests can pin it.
 */

import { createHash } from 'node:crypto';

export const DEDUP_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface DedupRecord {
  deliveryId: string;
  contentHash: string;
  firstSeenAt: number;
}

export interface DedupStore {
  /** Returns the prior record if a delivery id is remembered, else null. */
  lookup(deliveryId: string): Promise<DedupRecord | null>;
  remember(deliveryId: string, contentHash: string, at?: number): Promise<void>;
}

export class InMemoryDedupStore implements DedupStore {
  private readonly records = new Map<string, DedupRecord>();
  private readonly windowMs: number;

  constructor(windowMs: number = DEDUP_WINDOW_MS) {
    this.windowMs = windowMs;
  }

  async lookup(deliveryId: string): Promise<DedupRecord | null> {
    this.gc();
    return this.records.get(deliveryId) ?? null;
  }

  async remember(deliveryId: string, contentHash: string, at: number = Date.now()): Promise<void> {
    this.gc();
    this.records.set(deliveryId, { deliveryId, contentHash, firstSeenAt: at });
  }

  /** Test hook. */
  size(): number {
    return this.records.size;
  }

  /** Test hook — wipe all records so `__internals.__reset()` works. */
  clearForTests(): void {
    this.records.clear();
  }

  private gc(): void {
    const cutoff = Date.now() - this.windowMs;
    for (const [k, v] of this.records) {
      if (v.firstSeenAt < cutoff) this.records.delete(k);
    }
  }
}

export function contentHashOf(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

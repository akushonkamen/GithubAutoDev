/**
 * AuditChainService — T-M2-007, spec §19.
 *
 * Authoritative actions (label set, approval record, merge, intake
 * decision, gate decision) MUST be appended through this service so
 * that `previous_hash` is read and `record_hash` written under the
 * same atomic unit. Direct inserts into audit_records break the chain
 * and are detected by the reconciler (T-M10-001).
 *
 * The persisted shape matches the DB row (audit_records table in
 * packages/db): id, run_id, previous_hash, record_hash, kind, payload,
 * created_at. The higher-level zod schema in index.ts is a separate
 * representation used for cross-repo audit export; both share the same
 * hashing rule: sha256 over canonical(prev_hash || kind || run_id || at || payload).
 *
 * The InMemoryAuditChainService serializes appends per-run via an
 * internal queue so concurrent callers cannot race on prev_hash.
 * The Postgres adapter (M11) will use SELECT ... FOR UPDATE on the
 * latest row or a SERIALIZABLE transaction to achieve the same.
 */

import { createHash, randomUUID } from 'node:crypto';
import { canonicalize } from './index.js';

export interface DbAuditRecord {
  id: string;
  runId: string | null;
  previousHash: string | null;
  recordHash: string;
  kind: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditChainAppendInput {
  runId: string | null;
  kind: string;
  payload: Record<string, unknown>;
  /** Optional id for tests; production uses randomUUID. */
  id?: string;
  /** Optional fixed timestamp for tests; production uses now(). */
  createdAt?: string;
}

export interface AuditChainService {
  append(input: AuditChainAppendInput): Promise<DbAuditRecord>;
  listByRun(runId: string): Promise<readonly DbAuditRecord[]>;
  /** Verify the chain for a run; returns index of first broken record, or null. */
  verifyRun(runId: string): Promise<number | null>;
}

export function computeRecordHash(input: {
  previousHash: string | null;
  kind: string;
  runId: string | null;
  createdAt: string;
  payload: Record<string, unknown>;
}): string {
  const payload = canonicalize({
    previousHash: input.previousHash,
    kind: input.kind,
    runId: input.runId,
    createdAt: input.createdAt,
    payload: input.payload,
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

/**
 * In-memory implementation. Serializes appends via a per-run promise
 * chain so the read-then-write of previousHash is atomic from the
 * perspective of concurrent callers.
 */
export class InMemoryAuditChainService implements AuditChainService {
  private readonly records = new Map<string, DbAuditRecord>();
  /** runId -> last record; null runId uses the special key '<global>'. */
  private readonly tails = new Map<string, DbAuditRecord | null>();
  /** runId -> queue of pending appends, ensuring serial critical section. */
  private readonly queues = new Map<string, Promise<unknown>>();

  private tailKey(runId: string | null): string {
    return runId ?? '<global>';
  }

  private queueFor(key: string): Promise<unknown> {
    const q = this.queues.get(key) ?? Promise.resolve();
    return q;
  }

  private setQueue(key: string, p: Promise<unknown>): void {
    // Auto-cleanup once settled so we don't leak memory across long runs.
    this.queues.set(key, p);
    void p.finally(() => {
      if (this.queues.get(key) === p) this.queues.delete(key);
    });
  }

  async append(input: AuditChainAppendInput): Promise<DbAuditRecord> {
    const key = this.tailKey(input.runId);
    const prev = this.tails.get(key) ?? null;
    // Serialize: chain the next append after the previous one settles.
    const task = this.queueFor(key).then(async () => {
      const createdAt = input.createdAt ?? new Date().toISOString();
      const id = input.id ?? randomUUID();
      const previousHash = this.tails.get(key)?.recordHash ?? null;
      const recordHash = computeRecordHash({
        previousHash,
        kind: input.kind,
        runId: input.runId,
        createdAt,
        payload: input.payload,
      });
      const record: DbAuditRecord = {
        id,
        runId: input.runId,
        previousHash,
        recordHash,
        kind: input.kind,
        payload: input.payload,
        createdAt,
      };
      this.records.set(id, record);
      this.tails.set(key, record);
      return record;
    });
    this.setQueue(key, task);
    void prev;
    return task as Promise<DbAuditRecord>;
  }

  async listByRun(runId: string): Promise<readonly DbAuditRecord[]> {
    const out: DbAuditRecord[] = [];
    for (const r of this.records.values()) {
      if (r.runId === runId) out.push(r);
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }

  async verifyRun(runId: string): Promise<number | null> {
    const records = await this.listByRun(runId);
    let prevHash: string | null = null;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) return i;
      if (rec.previousHash !== prevHash) return i;
      const expected = computeRecordHash({
        previousHash: rec.previousHash,
        kind: rec.kind,
        runId: rec.runId,
        createdAt: rec.createdAt,
        payload: rec.payload,
      });
      if (expected !== rec.recordHash) return i;
      prevHash = rec.recordHash;
    }
    return null;
  }
}

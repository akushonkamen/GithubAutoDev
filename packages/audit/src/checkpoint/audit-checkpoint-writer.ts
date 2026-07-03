/**
 * AuditCheckpointWriter — T-M10-006, spec §19.
 *
 * Periodically writes a checkpoint of the audit chain head to external
 * immutable storage. The checkpoint is signed (HMAC) so any future
 * tampering with the chain can be detected by the verifier.
 *
 * Contract:
 *   - The writer never overwrites a checkpoint: each call uses the next seq.
 *   - The signature covers the canonical JSON of {seq, chainHead, runId,
 *     at, recordCount}. The verifier recomputes and timing-safe-compares.
 */

import type { AuditChainService, DbAuditRecord } from '../chain-service.js';
import {
  type CheckpointPayload,
  type CheckpointRecord,
  type ImmutableStorageAdapter,
  signCheckpoint,
} from './immutable-storage-adapter.js';

export interface AuditCheckpointWriterDeps {
  chain: AuditChainService;
  storage: ImmutableStorageAdapter;
  /** HMAC secret. Production pulls from a KMS-backed secret loader. */
  secret: string;
  /** Optional: scope checkpoints to a single run (null = global). */
  runId?: string | null;
}

export interface WriteCheckpointInput {
  /** Defaults to deps.runId (or null for the global chain). */
  runId?: string | null;
  /** Optional fixed `at` for tests. */
  at?: string;
}

export class AuditCheckpointWriter {
  constructor(private readonly deps: AuditCheckpointWriterDeps) {}

  async write(input: WriteCheckpointInput = {}): Promise<CheckpointRecord> {
    const runId = input.runId !== undefined ? input.runId : (this.deps.runId ?? null);
    const records: readonly DbAuditRecord[] =
      runId === null ? [] : await this.deps.chain.listByRun(runId);
    // For null runId we currently treat the chain as empty (the global
    // chain lives across runs; a future repo-scoped query will land with
    // the Postgres adapter). recordCount + chainHead still capture the
    // per-run scope deterministically.
    const last = records[records.length - 1] ?? null;
    const chainHead = last?.recordHash ?? 'sha256:'.padEnd(71, '0');
    const recordCount = records.length;
    const at = input.at ?? new Date().toISOString();
    const seq = (await this.deps.storage.latest()) ?? 0;
    const payload: CheckpointPayload = {
      seq: seq + 1,
      chainHead,
      runId,
      at,
      recordCount,
    };
    const signature = signCheckpoint(payload, this.deps.secret);
    const record: CheckpointRecord = { ...payload, signature };
    await this.deps.storage.write(record);
    return record;
  }
}

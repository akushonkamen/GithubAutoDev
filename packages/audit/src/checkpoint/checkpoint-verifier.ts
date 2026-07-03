/**
 * CheckpointVerifier — T-M10-006, spec §19.
 *
 * Verifies that the historical audit record matches a checkpoint:
 *
 *   1. Re-read the latest checkpoint from immutable storage.
 *   2. Re-walk the in-DB chain to confirm that:
 *      a. The chain is internally intact (no broken record_hash /
 *         prev_hash links).
 *      b. The chain's actual head matches the checkpoint.chainHead.
 *      c. The checkpoint signature is valid.
 *
 * If any step fails, return { ok: false, brokenIndex } so callers
 * can alert. A mutated mid-chain record is detected by step (2a)'s
 * internal chain integrity check; a mutated head is detected by (2b).
 */

import { type AuditChainService, computeRecordHash } from '../chain-service.js';
import {
  type CheckpointRecord,
  type ImmutableStorageAdapter,
  verifyCheckpointSignature,
} from './immutable-storage-adapter.js';

export interface VerifyResult {
  ok: boolean;
  /** Index of the first broken audit record (when integrity fails). */
  brokenIndex?: number | null;
  /** Reason code on failure. */
  reason?: string;
  /** The checkpoint that was verified, when one exists. */
  checkpoint?: CheckpointRecord | null;
}

export interface CheckpointVerifierDeps {
  chain: AuditChainService;
  storage: ImmutableStorageAdapter;
  secret: string;
}

export class CheckpointVerifier {
  constructor(private readonly deps: CheckpointVerifierDeps) {}

  async verify(runId: string): Promise<VerifyResult> {
    const records = await this.deps.chain.listByRun(runId);
    if (records.length === 0) {
      return { ok: true, reason: 'no-records', brokenIndex: null };
    }
    // 1. Internal chain integrity — recompute hashes and prev_hash links.
    let prevHash: string | null = null;
    for (let i = 0; i < records.length; i++) {
      const rec = records[i];
      if (!rec) return { ok: false, reason: 'missing-record', brokenIndex: i };
      if (rec.previousHash !== prevHash) {
        return { ok: false, reason: 'prev-hash-mismatch', brokenIndex: i };
      }
      // Recompute the record hash via the chain service's hashing rule so
      // we detect tampering even when a DB row's payload is mutated in
      // place without re-hashing. This mirrors computeRecordHash.
      const expected = computeRecordHash({
        previousHash: rec.previousHash,
        kind: rec.kind,
        runId: rec.runId,
        createdAt: rec.createdAt,
        payload: rec.payload,
      });
      if (expected !== rec.recordHash) {
        return { ok: false, reason: 'record-hash-mismatch', brokenIndex: i };
      }
      prevHash = rec.recordHash;
    }
    // 2. Cross-check against the latest checkpoint.
    const latestSeq = await this.deps.storage.latest();
    if (latestSeq === null) {
      return { ok: true, reason: 'no-checkpoint', brokenIndex: null };
    }
    const cp = await this.deps.storage.read(latestSeq);
    if (!cp) {
      return { ok: false, reason: 'checkpoint-missing', brokenIndex: null };
    }
    if (!verifyCheckpointSignature(cp, this.deps.secret)) {
      return { ok: false, reason: 'signature-invalid', checkpoint: cp, brokenIndex: null };
    }
    const actualHead = records[records.length - 1]?.recordHash ?? null;
    if (cp.chainHead !== actualHead) {
      return { ok: false, reason: 'head-mismatch', checkpoint: cp, brokenIndex: null };
    }
    if (cp.recordCount !== records.length) {
      return { ok: false, reason: 'count-mismatch', checkpoint: cp, brokenIndex: null };
    }
    return { ok: true, checkpoint: cp, brokenIndex: null };
  }
}

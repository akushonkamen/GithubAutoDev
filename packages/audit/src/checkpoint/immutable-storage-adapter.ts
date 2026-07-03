/**
 * ImmutableStorageAdapter — T-M10-006, spec §19.
 *
 * External immutable storage for audit-chain checkpoints. A checkpoint
 * is the signed (HMAC) chain head + a summary written periodically so
 * the chain can be re-verified against an out-of-band anchor.
 *
 * Implementations:
 *   - InMemoryImmutableAdapter: tests / startup mode.
 *   - S3ImmutableAdapter (stub): production wires Object Lock + WORM.
 *
 * The interface is intentionally tiny: write is append-only, read is
 * by checkpoint id. Once written, a checkpoint MUST NOT be mutable.
 */

import { createHash, createHmac } from 'node:crypto';
import { stableJsonStringify } from '@cgao/schemas';

export interface CheckpointRecord {
  /** Monotonic sequence number. */
  seq: number;
  /** sha256 of the latest chain record. */
  chainHead: string;
  /** Run id scope (or null for the global chain). */
  runId: string | null;
  /** ISO-8601 timestamp the checkpoint was written. */
  at: string;
  /** Number of records covered by this checkpoint. */
  recordCount: number;
  /** HMAC over the rest of the record. */
  signature: string;
}

export interface CheckpointPayload {
  seq: number;
  chainHead: string;
  runId: string | null;
  at: string;
  recordCount: number;
}

export interface ImmutableStorageAdapter {
  write(record: CheckpointRecord): Promise<void>;
  read(seq: number): Promise<CheckpointRecord | null>;
  /** Latest sequence number persisted, or null if none. */
  latest(): Promise<number | null>;
  /** Return all records, ordered by seq ascending. */
  list(): Promise<readonly CheckpointRecord[]>;
}

/**
 * Compute the HMAC signature for a checkpoint. The signature covers
 * every field except itself, in canonical JSON form. Spec §19.
 */
export function signCheckpoint(payload: CheckpointPayload, secret: string): string {
  const body = stableJsonStringify(payload);
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Verify a checkpoint signature; returns true iff valid. */
export function verifyCheckpointSignature(record: CheckpointRecord, secret: string): boolean {
  const payload: CheckpointPayload = {
    seq: record.seq,
    chainHead: record.chainHead,
    runId: record.runId,
    at: record.at,
    recordCount: record.recordCount,
  };
  const expected = signCheckpoint(payload, secret);
  return timingSafeHexEqual(expected, record.signature);
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    const ca = a.codePointAt(i) ?? 0;
    const cb = b.codePointAt(i) ?? 0;
    diff |= ca ^ cb;
  }
  return diff === 0;
}

/** In-memory adapter for tests. */
export class InMemoryImmutableAdapter implements ImmutableStorageAdapter {
  private readonly records = new Map<number, CheckpointRecord>();

  async write(record: CheckpointRecord): Promise<void> {
    if (this.records.has(record.seq)) {
      throw new Error(`ImmutableStorageAdapter: checkpoint seq=${record.seq} already written`);
    }
    this.records.set(record.seq, { ...record });
  }

  async read(seq: number): Promise<CheckpointRecord | null> {
    const r = this.records.get(seq);
    return r ? { ...r } : null;
  }

  async latest(): Promise<number | null> {
    let max: number | null = null;
    for (const k of this.records.keys()) {
      if (max === null || k > max) max = k;
    }
    return max;
  }

  async list(): Promise<readonly CheckpointRecord[]> {
    return [...this.records.values()].sort((a, b) => a.seq - b.seq);
  }
}

/**
 * S3 adapter stub. Production wires AWS SDK with Object Lock; this
 * stub throws to make accidental usage obvious in non-prod environments.
 */
export class S3ImmutableAdapter implements ImmutableStorageAdapter {
  constructor(
    private readonly bucket: string,
    private readonly prefix: string,
  ) {
    void this.bucket;
    void this.prefix;
  }

  async write(): Promise<void> {
    throw new Error(
      'S3ImmutableAdapter: not wired in this environment (use InMemoryImmutableAdapter for tests)',
    );
  }

  async read(): Promise<CheckpointRecord | null> {
    throw new Error('S3ImmutableAdapter: not wired in this environment');
  }

  async latest(): Promise<number | null> {
    throw new Error('S3ImmutableAdapter: not wired in this environment');
  }

  async list(): Promise<readonly CheckpointRecord[]> {
    throw new Error('S3ImmutableAdapter: not wired in this environment');
  }
}

/** Convenience: derive a chainHead from a buffer of audit records. */
export function hashRecords(records: readonly string[]): string {
  const h = createHash('sha256');
  for (const r of records) h.update(r);
  return `sha256:${h.digest('hex')}`;
}

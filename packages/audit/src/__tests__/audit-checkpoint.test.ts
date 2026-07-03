/**
 * T-M10-006 AuditCheckpointWriter + CheckpointVerifier.
 *
 * Spec §19 — checkpoints MUST be signed (HMAC) and the verifier MUST
 * detect tampering with mid-chain records.
 */

import { describe, expect, it } from 'vitest';
import {
  AuditCheckpointWriter,
  CheckpointVerifier,
  InMemoryAuditChainService,
  InMemoryImmutableAdapter,
  verifyCheckpointSignature,
} from '../index.js';

function makeChain() {
  const chain = new InMemoryAuditChainService();
  return chain;
}

describe('T-M10-006 AuditCheckpointWriter', () => {
  it('writes a signed checkpoint with the current chain head', async () => {
    const chain = makeChain();
    await chain.append({
      runId: 'run_1',
      kind: 'label.set',
      payload: { label: 'cgao:plan-ready' },
    });
    const storage = new InMemoryImmutableAdapter();
    const writer = new AuditCheckpointWriter({
      chain,
      storage,
      secret: 'dev-secret',
      runId: 'run_1',
    });
    const cp = await writer.write();
    expect(cp.seq).toBe(1);
    expect(cp.chainHead).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(cp.recordCount).toBe(1);
    expect(verifyCheckpointSignature(cp, 'dev-secret')).toBe(true);
  });

  it('refuses to overwrite an existing checkpoint seq (append-only)', async () => {
    const chain = makeChain();
    await chain.append({ runId: 'run_2', kind: 'label.set', payload: {} });
    const storage = new InMemoryImmutableAdapter();
    const writer = new AuditCheckpointWriter({
      chain,
      storage,
      secret: 'dev-secret',
      runId: 'run_2',
    });
    await writer.write();
    await writer.write();
    const list = await storage.list();
    expect(list.length).toBe(2);
    expect(list[0]?.seq).toBe(1);
    expect(list[1]?.seq).toBe(2);
  });
});

describe('T-M10-006 CheckpointVerifier', () => {
  it('verifies a clean chain against a checkpoint', async () => {
    const chain = makeChain();
    await chain.append({ runId: 'run_3', kind: 'label.set', payload: { a: 1 } });
    await chain.append({ runId: 'run_3', kind: 'label.unset', payload: { b: 2 } });
    const storage = new InMemoryImmutableAdapter();
    const writer = new AuditCheckpointWriter({
      chain,
      storage,
      secret: 'dev-secret',
      runId: 'run_3',
    });
    await writer.write();
    const verifier = new CheckpointVerifier({ chain, storage, secret: 'dev-secret' });
    const out = await verifier.verify('run_3');
    expect(out.ok).toBe(true);
    expect(out.checkpoint?.recordCount).toBe(2);
  });

  it('detects tampering when a mid-chain audit record is mutated', async () => {
    const chain = makeChain();
    const a1 = await chain.append({ runId: 'run_4', kind: 'label.set', payload: { x: 1 } });
    await chain.append({ runId: 'run_4', kind: 'label.unset', payload: { y: 2 } });
    const storage = new InMemoryImmutableAdapter();
    const writer = new AuditCheckpointWriter({
      chain,
      storage,
      secret: 'dev-secret',
      runId: 'run_4',
    });
    await writer.write();
    // Tamper: reach into the in-memory chain and mutate the first record's payload.
    // The InMemoryAuditChainService stores records in a private Map; we re-append
    // under the same id with a different payload to simulate tampering.
    const priv = chain as unknown as {
      records: Map<string, { id: string; payload: Record<string, unknown>; recordHash: string }>;
    };
    const row = priv.records.get(a1.id);
    if (row) {
      row.payload = { x: 999 };
      // Mutating the payload without re-hashing leaves recordHash stale,
      // simulating a tampered DB row.
    }
    const verifier = new CheckpointVerifier({ chain, storage, secret: 'dev-secret' });
    const out = await verifier.verify('run_4');
    // Verifier may flag via signature/head/count; either way it must NOT be ok.
    expect(out.ok).toBe(false);
  });

  it('rejects when the checkpoint signature is invalid (wrong secret)', async () => {
    const chain = makeChain();
    await chain.append({ runId: 'run_5', kind: 'label.set', payload: {} });
    const storage = new InMemoryImmutableAdapter();
    const writer = new AuditCheckpointWriter({
      chain,
      storage,
      secret: 'real-secret',
      runId: 'run_5',
    });
    await writer.write();
    const verifier = new CheckpointVerifier({ chain, storage, secret: 'wrong-secret' });
    const out = await verifier.verify('run_5');
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('signature-invalid');
  });

  it('returns ok with no-checkpoint when no checkpoint has been written yet', async () => {
    const chain = makeChain();
    await chain.append({ runId: 'run_6', kind: 'label.set', payload: {} });
    const storage = new InMemoryImmutableAdapter();
    const verifier = new CheckpointVerifier({ chain, storage, secret: 'dev-secret' });
    const out = await verifier.verify('run_6');
    expect(out.ok).toBe(true);
    expect(out.reason).toBe('no-checkpoint');
  });
});

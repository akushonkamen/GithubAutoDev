/**
 * AuditChainService — T-M2-007, spec §19.
 *
 * Verifies atomic prev-hash linking, concurrency serialization,
 * tamper detection, and per-run chain isolation.
 */

import { describe, expect, it } from 'vitest';
import {
  type DbAuditRecord,
  InMemoryAuditChainService,
  computeRecordHash,
} from '../chain-service.js';

function mkPayload(n: number): Record<string, unknown> {
  return { n, note: `event-${n}` };
}

describe('InMemoryAuditChainService.append (T-M2-007)', () => {
  it('links the genesis record to null previousHash', async () => {
    const svc = new InMemoryAuditChainService();
    const r = await svc.append({ runId: 'r1', kind: 'label.set', payload: mkPayload(0) });
    expect(r.previousHash).toBeNull();
    expect(r.recordHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('links subsequent records to the previous recordHash', async () => {
    const svc = new InMemoryAuditChainService();
    const a = await svc.append({ runId: 'r1', kind: 'label.set', payload: mkPayload(0) });
    const b = await svc.append({ runId: 'r1', kind: 'approval.recorded', payload: mkPayload(1) });
    expect(b.previousHash).toBe(a.recordHash);
  });

  it('isolates chains per run (null runId is its own chain)', async () => {
    const svc = new InMemoryAuditChainService();
    const a = await svc.append({ runId: 'r1', kind: 'label.set', payload: {} });
    const b = await svc.append({ runId: 'r2', kind: 'label.set', payload: {} });
    const c = await svc.append({ runId: null, kind: 'intake.drop', payload: {} });
    expect(a.previousHash).toBeNull();
    expect(b.previousHash).toBeNull();
    expect(c.previousHash).toBeNull();
  });

  it('serializes concurrent appends so prev-hash chain stays linear', async () => {
    const svc = new InMemoryAuditChainService();
    const inputs = [0, 1, 2, 3, 4].map((n) =>
      svc.append({ runId: 'rc', kind: 'label.set', payload: mkPayload(n) }),
    );
    const records = await Promise.all(inputs);
    // All 5 should chain in some order, each prev pointing to a real prior recordHash
    const hashSet = new Set(records.map((r) => r.recordHash));
    expect(hashSet.size).toBe(5);
    const genesis = records.filter((r) => r.previousHash === null);
    expect(genesis.length).toBe(1);
    // Walk the chain end-to-end
    let cur: DbAuditRecord | undefined = genesis[0];
    const visited = [cur];
    while (cur) {
      const next = records.find((r) => r.previousHash === cur?.recordHash);
      if (!next) break;
      visited.push(next);
      cur = next;
    }
    expect(visited.length).toBe(5);
  });

  it('produces deterministic recordHash for the same inputs', () => {
    const h1 = computeRecordHash({
      previousHash: null,
      kind: 'label.set',
      runId: 'r1',
      createdAt: '2026-07-03T10:00:00.000Z',
      payload: { x: 1 },
    });
    const h2 = computeRecordHash({
      previousHash: null,
      kind: 'label.set',
      runId: 'r1',
      createdAt: '2026-07-03T10:00:00.000Z',
      payload: { x: 1 },
    });
    expect(h1).toBe(h2);
  });

  it('recordHash changes when payload changes (tamper detection)', () => {
    const a = computeRecordHash({
      previousHash: null,
      kind: 'label.set',
      runId: 'r1',
      createdAt: '2026-07-03T10:00:00.000Z',
      payload: { x: 1 },
    });
    const b = computeRecordHash({
      previousHash: null,
      kind: 'label.set',
      runId: 'r1',
      createdAt: '2026-07-03T10:00:00.000Z',
      payload: { x: 2 },
    });
    expect(a).not.toBe(b);
  });
});

describe('InMemoryAuditChainService.verifyRun (T-M2-007)', () => {
  it('returns null for an intact chain', async () => {
    const svc = new InMemoryAuditChainService();
    await svc.append({ runId: 'r1', kind: 'label.set', payload: {} });
    await svc.append({ runId: 'r1', kind: 'approval.recorded', payload: {} });
    expect(await svc.verifyRun('r1')).toBeNull();
  });

  it('returns null for a run with no records', async () => {
    const svc = new InMemoryAuditChainService();
    expect(await svc.verifyRun('nope')).toBeNull();
  });
});

describe('InMemoryAuditChainService.listByRun (T-M2-007)', () => {
  it('returns only records for the requested run, in createdAt order', async () => {
    const svc = new InMemoryAuditChainService();
    await svc.append({
      runId: 'r1',
      kind: 'label.set',
      payload: {},
      createdAt: '2026-07-03T10:00:01.000Z',
    });
    await svc.append({
      runId: 'r2',
      kind: 'label.set',
      payload: {},
      createdAt: '2026-07-03T10:00:00.000Z',
    });
    await svc.append({
      runId: 'r1',
      kind: 'approval.recorded',
      payload: {},
      createdAt: '2026-07-03T10:00:02.000Z',
    });
    const r1 = await svc.listByRun('r1');
    expect(r1.length).toBe(2);
    expect(r1[0]?.kind).toBe('label.set');
    expect(r1[1]?.kind).toBe('approval.recorded');
  });
});

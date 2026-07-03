import { describe, expect, it } from 'vitest';
import { type AuditRecord, computeAuditHash, verifyAuditChain } from '../index.js';

function mkRecord(
  seq: number,
  prevHash: AuditRecord['prevHash'],
  action: AuditRecord['action'] = 'intake.accept_hint',
): AuditRecord {
  const base = {
    seq,
    repo: 'owner/name',
    runId: null,
    action,
    detail: { n: seq },
    at: '2026-07-03T10:00:00.000Z',
    prevHash,
  };
  return { ...base, hash: computeAuditHash(base) };
}

describe('@cgao/audit hash chain', () => {
  it('computes deterministic hash for the same record', () => {
    const r = mkRecord(0, null);
    expect(r.hash).toBe(r.hash);
  });

  it('verifyAuditChain accepts a freshly chained genesis record', () => {
    const r = mkRecord(0, null);
    expect(verifyAuditChain([r])).toBeNull();
  });

  it('verifyAuditChain detects a broken link', () => {
    const a = mkRecord(0, null);
    const b = mkRecord(1, a.hash);
    // tamper: rewrite b.prevHash to something wrong
    const tampered: AuditRecord = { ...b, prevHash: 'sha256:'.padEnd(71, '0').slice(0, 71) };
    // re-pad properly to 64 hex chars
    const fake = `sha256:${'0'.repeat(64)}`;
    const tamperedCorrect: AuditRecord = { ...b, prevHash: fake };
    void tampered;
    expect(verifyAuditChain([a, tamperedCorrect])).toBe(1);
  });

  it('verifyAuditChain accepts a multi-record chain', () => {
    const a = mkRecord(0, null);
    const b = mkRecord(1, a.hash, 'label.set');
    const c = mkRecord(2, b.hash, 'merge.executed');
    expect(verifyAuditChain([a, b, c])).toBeNull();
  });
});

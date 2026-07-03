/**
 * Audit hash chain regression — attack-scenarios/stale-merge.md §5,
 * spec §19, T-M2-007 / T-M10-001.
 *
 * Locks the chain-of-custody property: any historical mutation must
 * be detected by `verifyAuditChain`. This is the cryptographic backstop
 * for stale-approval / TOCTOU detection.
 */

import { type AuditRecord, computeAuditHash, verifyAuditChain } from '@cgao/audit';
import { describe, expect, it } from 'vitest';

function mkRecord(
  seq: number,
  prevHash: string | null,
  action: AuditRecord['action'],
): AuditRecord {
  const base = {
    seq,
    repo: 'cgao/test',
    runId: null,
    action,
    detail: { number: seq },
    at: '2026-07-03T00:00:00Z',
    prevHash,
  };
  return { ...base, hash: computeAuditHash(base) };
}

function mkChain(n: number): AuditRecord[] {
  const out: AuditRecord[] = [];
  let prev: string | null = null;
  for (let i = 0; i < n; i++) {
    const rec = mkRecord(i, prev, i % 2 === 0 ? 'label.set' : 'approval.recorded');
    out.push(rec);
    prev = rec.hash;
  }
  return out;
}

function nth(chain: AuditRecord[], i: number): AuditRecord {
  const r = chain[i];
  if (!r) throw new Error(`chain[${i}] missing`);
  return r;
}

describe('audit hash chain integrity', () => {
  it('accepts an untampered chain', () => {
    expect(verifyAuditChain(mkChain(5))).toBeNull();
  });

  it('detects a tampered detail field in the middle of the chain', () => {
    const chain = mkChain(5);
    chain[1] = { ...nth(chain, 1), detail: { number: 999 } };
    expect(verifyAuditChain(chain)).toBe(1);
  });

  it('detects a deleted record (chain re-link attack)', () => {
    const chain = mkChain(5);
    const spliced = [nth(chain, 0), nth(chain, 2), nth(chain, 3), nth(chain, 4)];
    expect(verifyAuditChain(spliced)).toBe(1);
  });

  it('detects an out-of-order prevHash', () => {
    const chain = mkChain(4);
    chain[2] = { ...nth(chain, 2), prevHash: nth(chain, 0).hash };
    expect(verifyAuditChain(chain)).toBe(2);
  });
});

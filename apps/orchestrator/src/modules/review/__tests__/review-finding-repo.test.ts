/**
 * T-M8-003 ReviewFindingRepo + finding_hash.
 *
 * Contracts:
 *   - Identical finding reported twice → same hash, deduped.
 *   - Findings bound to head_sha.
 *   - findBlocking(prNumber) returns only blocking, open findings.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { InMemoryReviewFindingRepository } from '@cgao/db';
import { describe, expect, it } from 'vitest';
import { computeFindingHash } from '../finding-hash.js';
import { ReviewFindingRepo } from '../review-finding-repo.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function makeFinding(
  overrides: Partial<{
    runId: string;
    headSha: string;
    rule: string;
    file: string;
    message: string;
    reviewer: 'code' | 'security';
    severity: 'low' | 'medium' | 'high' | 'critical';
    blocking: boolean;
  }> = {},
) {
  const reviewer = overrides.reviewer ?? 'code';
  const rule = overrides.rule ?? 'missing-test';
  const file = overrides.file ?? 'src/foo.ts';
  const lineStart = 10;
  const lineEnd = 12;
  const message = overrides.message ?? 'add a test';
  const runId = overrides.runId ?? 'run_1';
  const headSha = overrides.headSha ?? HEAD_A;
  return {
    findingHash: computeFindingHash({
      runId,
      headSha,
      reviewer,
      rule,
      file,
      lineStart,
      lineEnd,
      message,
    }),
    reviewer,
    rule,
    file,
    lineStart,
    lineEnd,
    title: 't',
    message,
    severity: overrides.severity ?? 'low',
    blocking: overrides.blocking ?? false,
  };
}

describe('T-M8-003 computeFindingHash', () => {
  it('is stable for identical identity fields', () => {
    const a = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_A,
      reviewer: 'code',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    const b = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_A,
      reviewer: 'code',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('changes when headSha changes', () => {
    const a = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_A,
      reviewer: 'code',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    const b = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_B,
      reviewer: 'code',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    expect(a).not.toBe(b);
  });

  it('changes when reviewer class changes', () => {
    const a = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_A,
      reviewer: 'code',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    const b = computeFindingHash({
      runId: 'r1',
      headSha: HEAD_A,
      reviewer: 'security',
      rule: 'r',
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message: 'm',
    });
    expect(a).not.toBe(b);
  });
});

describe('T-M8-003 ReviewFindingRepo', () => {
  it('dedups identical findings by finding_hash', async () => {
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    const finding = makeFinding();
    const a = await repo.recordReviewResult({
      runId: 'run_1',
      prNumber: 42,
      headSha: HEAD_A,
      findings: [finding],
    });
    const b = await repo.recordReviewResult({
      runId: 'run_1',
      prNumber: 42,
      headSha: HEAD_A,
      findings: [finding],
    });
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0]?.id).toBe(b[0]?.id);
    expect(a[0]?.findingHash).toBe(finding.findingHash);
  });

  it('binds findings to head_sha', async () => {
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    await repo.recordReviewResult({
      runId: 'run_1',
      prNumber: 7,
      headSha: HEAD_A,
      findings: [makeFinding({ headSha: HEAD_A })],
    });
    const rows = await repo.findByRun('run_1');
    expect(rows.every((r) => r.headSha === HEAD_A)).toBe(true);
  });

  it('findBlocking returns only blocking, open findings', async () => {
    const repo = new ReviewFindingRepo({ repo: new InMemoryReviewFindingRepository() });
    await repo.recordReviewResult({
      runId: 'run_1',
      prNumber: 5,
      headSha: HEAD_A,
      findings: [
        makeFinding({ rule: 'b1', blocking: true, severity: 'high' }),
        makeFinding({ rule: 'b2', blocking: false, severity: 'low' }),
      ],
    });
    const blocking = await repo.findBlocking(5);
    expect(blocking).toHaveLength(1);
    expect(blocking[0]?.blocking).toBe(true);
    expect(blocking[0]?.status).toBe('open');

    // Close the blocking finding; findBlocking should now return zero.
    const blockingId = blocking[0]?.id;
    if (!blockingId) throw new Error('blocking finding not found');
    await repo.setStatus(blockingId, { status: 'fixed', closedAt: new Date() });
    const after = await repo.findBlocking(5);
    expect(after).toHaveLength(0);
  });

  it('ignores the unused audit dep', () => {
    // sanity: the audit service is used by the lifecycle service, not the repo.
    void new InMemoryAuditChainService();
    expect(true).toBe(true);
  });
});

/**
 * T-M8-004 FindingLifecycleService.
 *
 * Contracts (spec §12.9):
 *   - Blocking finding cannot be auto-closed by omission; only by explicit
 *     markFixed with same reviewer class on new headSha.
 *   - dismiss requires non-empty reason; reviewer cannot dismiss its own finding.
 *   - audit chain extended on every transition.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { InMemoryReviewFindingRepository } from '@cgao/db';
import { describe, expect, it } from 'vitest';
import { computeFindingHash } from '../finding-hash.js';
import { FindingLifecycleService, LifecycleError } from '../finding-lifecycle.js';
import { ReviewFindingRepo } from '../review-finding-repo.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

async function seed(args: {
  repo: ReviewFindingRepo;
  audit: InMemoryAuditChainService;
  blocking: boolean;
  reviewer?: 'code' | 'security';
  prNumber?: number;
  rule?: string;
  message?: string;
}) {
  const reviewer = args.reviewer ?? 'code';
  const rule = args.rule ?? 'r';
  const message = args.message ?? 'm';
  const finding = {
    findingHash: computeFindingHash({
      runId: 'run_1',
      headSha: HEAD_A,
      reviewer,
      rule,
      file: 'f',
      lineStart: 1,
      lineEnd: 2,
      message,
    }),
    reviewer,
    rule,
    file: 'f',
    lineStart: 1,
    lineEnd: 2,
    title: 't',
    message,
    severity: 'medium' as const,
    blocking: args.blocking,
  };
  const rows = await args.repo.recordReviewResult({
    runId: 'run_1',
    prNumber: args.prNumber ?? 5,
    headSha: HEAD_A,
    findings: [finding],
  });
  const row = rows[0];
  if (!row) throw new Error('seed finding not persisted');
  return row;
}

describe('T-M8-004 FindingLifecycleService', () => {
  it('markFixed closes a non-blocking finding', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    const row = await seed({ repo, audit, blocking: false });
    const updated = await svc.markFixed({
      findingId: row.id,
      reviewer: 'code',
      confirmedAtHeadSha: HEAD_B,
      actor: 'cgao:reviewer:code',
    });
    expect(updated.status).toBe('fixed');
    const records = await audit.listByRun('run_1');
    expect(records.some((r) => r.kind === 'review.finding.fixed')).toBe(true);
  });

  it('markFixedByOmission skips BLOCKING findings (cannot auto-close)', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    await seed({
      repo,
      audit,
      blocking: true,
      prNumber: 8,
      rule: 'blocking-rule',
      message: 'blocking',
    });
    await seed({
      repo,
      audit,
      blocking: false,
      prNumber: 8,
      rule: 'nonblocking-rule',
      message: 'minor',
    });
    // simulate a fresh review at HEAD_B that omits BOTH findings.
    const closed = await svc.markFixedByOmission({
      prNumber: 8,
      newHeadSha: HEAD_B,
      newFindingHashes: [],
      actor: 'cgao:reviewer:code',
    });
    expect(closed).toHaveLength(1); // only the non-blocking one
    const remaining = await repo.findByPr(8);
    const stillOpenBlocking = remaining.find((r) => r.blocking && r.status === 'open');
    expect(stillOpenBlocking).toBeDefined();
  });

  it('markFixed rejects reviewer class mismatch', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    const row = await seed({ repo, audit, blocking: false, reviewer: 'security' });
    await expect(
      svc.markFixed({
        findingId: row.id,
        reviewer: 'code',
        confirmedAtHeadSha: HEAD_B,
        actor: 'cgao:reviewer:code',
      }),
    ).rejects.toBeInstanceOf(LifecycleError);
  });

  it('dismiss requires non-empty reason', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    const row = await seed({ repo, audit, blocking: false });
    await expect(
      svc.dismiss({ findingId: row.id, reason: '   ', by: 'maintainer' }),
    ).rejects.toMatchObject({ code: 'empty_dismiss_reason' });
  });

  it('dismiss forbids self-dismiss (reviewer closing its own finding)', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    const row = await seed({ repo, audit, blocking: false });
    await expect(
      svc.dismiss({ findingId: row.id, reason: 'looks fine', by: 'cgao:reviewer:code' }),
    ).rejects.toMatchObject({ code: 'self_dismiss_forbidden' });
  });

  it('dismiss extends audit chain', async () => {
    const dbRepo = new InMemoryReviewFindingRepository();
    const repo = new ReviewFindingRepo({ repo: dbRepo });
    const audit = new InMemoryAuditChainService();
    const svc = new FindingLifecycleService({ repo, audit });
    const row = await seed({ repo, audit, blocking: false });
    await svc.dismiss({ findingId: row.id, reason: 'false positive', by: 'alice' });
    const records = await audit.listByRun('run_1');
    expect(records.some((r) => r.kind === 'review.finding.dismissed')).toBe(true);
  });
});

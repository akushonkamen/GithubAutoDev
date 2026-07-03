/**
 * T-M10-001 DriftDetector — emits per-drift events to the bus.
 */

import { InMemoryEventBus } from '@cgao/eventbus';
import { describe, expect, it } from 'vitest';
import { DriftDetector, type DbProjection } from '../drift-detector.js';
import type { DriftReport } from '../github-hydrator.js';

function baseProjection(overrides: Partial<DbProjection> = {}): DbProjection {
  return {
    runId: 'run_1',
    repo: 'cgao/test',
    issueNumber: 1,
    prNumber: null,
    expectedLabels: [],
    expectsStatusComment: false,
    expectedIssueState: 'open',
    expectedHeadSha: null,
    expectedReviews: [],
    expectedChecks: [],
    ...overrides,
  };
}

function baseReport(overrides: Partial<DriftReport> = {}): DriftReport {
  return {
    runId: 'run_1',
    repo: 'cgao/test',
    issueNumber: 1,
    prNumber: null,
    live: {
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 1,
      prNumber: null,
      issue: null,
      pr: null,
    },
    fetchedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('T-M10-001 DriftDetector', () => {
  it('detects missing labels', async () => {
    const bus = new InMemoryEventBus();
    const det = new DriftDetector(bus);
    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      seen.push((m.payload as { kind: string }).kind);
    });
    await det.detect(
      baseReport({
        live: {
          runId: 'run_1',
          repo: 'cgao/test',
          issueNumber: 1,
          prNumber: null,
          issue: {
            repo: 'cgao/test',
            issueNumber: 1,
            labels: [],
            hasStatusComment: true,
            state: 'open',
          },
          pr: null,
        },
      }),
      baseProjection({ expectedLabels: ['cgao:plan-ready'] }),
    );
    expect(seen).toEqual(['issue.label_mismatch']);
  });

  it('detects extra (human-mutated) labels', async () => {
    const bus = new InMemoryEventBus();
    const det = new DriftDetector(bus);
    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      const p = m.payload as { kind: string; detail: { extra: string[] } };
      if (p.kind === 'issue.label_mismatch') seen.push(...p.detail.extra);
    });
    await det.detect(
      baseReport({
        live: {
          runId: 'run_1',
          repo: 'cgao/test',
          issueNumber: 1,
          prNumber: null,
          issue: {
            repo: 'cgao/test',
            issueNumber: 1,
            labels: ['cgao:plan-ready', 'human:crazy'],
            hasStatusComment: true,
            state: 'open',
          },
          pr: null,
        },
      }),
      baseProjection({ expectedLabels: ['cgao:plan-ready'] }),
    );
    expect(seen).toEqual(['human:crazy']);
  });

  it('detects review divergence on a PR', async () => {
    const bus = new InMemoryEventBus();
    const det = new DriftDetector(bus);
    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      seen.push((m.payload as { kind: string }).kind);
    });
    await det.detect(
      baseReport({
        issueNumber: null,
        prNumber: 2,
        live: {
          runId: 'run_1',
          repo: 'cgao/test',
          issueNumber: null,
          prNumber: 2,
          issue: null,
          pr: {
            repo: 'cgao/test',
            prNumber: 2,
            headSha: 'a'.repeat(40),
            baseSha: 'b'.repeat(40),
            state: 'open',
            checks: [],
            reviews: [{ author: 'alice', state: 'APPROVED' }],
          },
        },
      }),
      baseProjection({
        issueNumber: null,
        prNumber: 2,
        expectedReviews: [{ author: 'alice', state: 'CHANGES_REQUESTED' }],
      }),
    );
    expect(seen).toContain('pr.review_divergence');
  });

  it('emits nothing when projection matches reality', async () => {
    const bus = new InMemoryEventBus();
    const det = new DriftDetector(bus);
    const seen: string[] = [];
    bus.subscribe('reconcile.drift.detected', (m) => {
      seen.push((m.payload as { kind: string }).kind);
    });
    await det.detect(
      baseReport({
        live: {
          runId: 'run_1',
          repo: 'cgao/test',
          issueNumber: 1,
          prNumber: null,
          issue: {
            repo: 'cgao/test',
            issueNumber: 1,
            labels: ['cgao:plan-ready'],
            hasStatusComment: true,
            state: 'open',
          },
          pr: null,
        },
      }),
      baseProjection({ expectedLabels: ['cgao:plan-ready'], expectsStatusComment: true }),
    );
    expect(seen).toEqual([]);
  });
});

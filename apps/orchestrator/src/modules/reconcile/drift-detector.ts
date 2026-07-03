/**
 * DriftDetector — T-M10-001, spec §12.2 / §14.1 / §14.2.
 *
 * Compares the DB projection against the GitHub reality (DriftReport) and
 * emits repair events on the bus. Each drift produces a single event so
 * downstream modules (intake, plan, merge, projection-reconciler) can
 * react independently.
 *
 * Events emitted:
 *   - reconcile.drift.detected       (every drift carries this envelope)
 *     sub-kind in payload.kind:
 *       - issue.label_mismatch
 *       - issue.status_comment_missing
 *       - issue.state_divergence
 *       - pr.head_sha_divergence
 *       - pr.review_divergence
 *       - pr.check_divergence
 *
 * Hard rule (spec §5, §19): every emitted event is best-effort repair
 * signal only. Authoritative label writes still go through the labeled
 * projection path which itself extends the audit chain.
 */

import type { EventBus } from '@cgao/eventbus';
import type { DriftReport, LiveIssueSnapshot, LivePrSnapshot } from './github-hydrator.js';

export interface DbProjection {
  runId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** Labels the DB believes should be on the issue (canonical projection). */
  expectedLabels: string[];
  /** True iff the DB believes a status comment should be present. */
  expectsStatusComment: boolean;
  /** Expected issue state per the workflow run state machine. */
  expectedIssueState: 'open' | 'closed';
  /** Expected PR head sha per the workflow run. */
  expectedHeadSha: string | null;
  /** Expected review decisions per the DB (review-findings repo). */
  expectedReviews: ReadonlyArray<{ author: string; state: string }>;
  /** Expected check conclusions per the DB. */
  expectedChecks: ReadonlyArray<{ name: string; conclusion: string | null }>;
}

export interface DriftEvent {
  kind: string;
  runId: string;
  repo: string;
  detail: Record<string, unknown>;
}

export interface DetectResult {
  drifts: DriftEvent[];
}

export class DriftDetector {
  constructor(private readonly bus: EventBus) {}

  async detect(report: DriftReport, projection: DbProjection): Promise<DetectResult> {
    const drifts: DriftEvent[] = [];
    const { live } = report;

    if (live.issue) {
      drifts.push(...this.detectIssueDrifts(report, projection, live.issue));
    }
    if (live.pr) {
      drifts.push(...this.detectPrDrifts(report, projection, live.pr));
    }

    for (const d of drifts) {
      await this.bus.publish({
        topic: 'reconcile.drift.detected',
        payload: { kind: d.kind, runId: d.runId, repo: d.repo, detail: d.detail },
        headers: { 'x-cgao-kind': d.kind, 'x-cgao-run': d.runId, 'x-cgao-repo': d.repo },
        traceId: null,
      });
    }
    return { drifts };
  }

  private detectIssueDrifts(
    report: DriftReport,
    projection: DbProjection,
    issue: LiveIssueSnapshot,
  ): DriftEvent[] {
    const out: DriftEvent[] = [];
    const expected = new Set(projection.expectedLabels);
    const actual = new Set(issue.labels);
    const missing = [...expected].filter((l) => !actual.has(l));
    const extra = [...actual].filter((l) => !expected.has(l));
    if (missing.length > 0 || extra.length > 0) {
      out.push({
        kind: 'issue.label_mismatch',
        runId: report.runId,
        repo: report.repo,
        detail: { missing, extra, issueNumber: issue.issueNumber },
      });
    }
    if (projection.expectsStatusComment && !issue.hasStatusComment) {
      out.push({
        kind: 'issue.status_comment_missing',
        runId: report.runId,
        repo: report.repo,
        detail: { issueNumber: issue.issueNumber },
      });
    }
    if (projection.expectedIssueState !== issue.state) {
      out.push({
        kind: 'issue.state_divergence',
        runId: report.runId,
        repo: report.repo,
        detail: {
          issueNumber: issue.issueNumber,
          expected: projection.expectedIssueState,
          actual: issue.state,
        },
      });
    }
    return out;
  }

  private detectPrDrifts(
    report: DriftReport,
    projection: DbProjection,
    pr: LivePrSnapshot,
  ): DriftEvent[] {
    const out: DriftEvent[] = [];
    if (projection.expectedHeadSha && projection.expectedHeadSha !== pr.headSha) {
      out.push({
        kind: 'pr.head_sha_divergence',
        runId: report.runId,
        repo: report.repo,
        detail: {
          prNumber: pr.prNumber,
          expected: projection.expectedHeadSha,
          actual: pr.headSha,
        },
      });
    }
    if (!sameReviews(projection.expectedReviews, pr.reviews)) {
      out.push({
        kind: 'pr.review_divergence',
        runId: report.runId,
        repo: report.repo,
        detail: { prNumber: pr.prNumber },
      });
    }
    if (!sameChecks(projection.expectedChecks, pr.checks)) {
      out.push({
        kind: 'pr.check_divergence',
        runId: report.runId,
        repo: report.repo,
        detail: { prNumber: pr.prNumber },
      });
    }
    return out;
  }
}

function sameReviews(
  a: ReadonlyArray<{ author: string; state: string }>,
  b: ReadonlyArray<{ author: string; state: string }>,
): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map((r) => `${r.author}:${r.state}`).sort();
  const sb = b.map((r) => `${r.author}:${r.state}`).sort();
  return sa.every((v, i) => v === sb[i]);
}

function sameChecks(
  a: ReadonlyArray<{ name: string; conclusion: string | null }>,
  b: ReadonlyArray<{ name: string; status: string; conclusion: string | null }>,
): boolean {
  if (a.length !== b.length) return false;
  const sa = a.map((c) => `${c.name}:${c.conclusion ?? ''}`).sort();
  const sb = b.map((c) => `${c.name}:${c.conclusion ?? ''}`).sort();
  return sa.every((v, i) => v === sb[i]);
}

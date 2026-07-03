/**
 * ReviewFindingRepo (orchestrator wrapper) — T-M8-003, spec §12.9 / §15.
 *
 * Wraps the db-level ReviewFindingRepository with the review-module's
 * domain types (ReviewFinding from the runner's ReviewResult) and
 * computes finding_hash via the shared computeFindingHash(). This is
 * the surface the orchestrator modules import; they never reach into
 * @cgao/db directly.
 *
 * Contract:
 *   - recordFromReview() takes a ReviewFinding + run/pr context, computes
 *     the canonical finding_hash, dedups via the db repo, and returns
 *     the persisted row.
 *   - findBlocking(prNumber) returns only blocking, OPEN findings.
 *   - findByHeadSha(headSha) lets the gate aggregator pull findings
 *     bound to a specific commit.
 */

import { randomUUID } from 'node:crypto';
import type { FindingStatus, ReviewFindingRepository, ReviewFindingRow } from '@cgao/db';
import { type ReviewerClass, computeFindingHash } from './finding-hash.js';
import type { ReviewFinding } from './review-result.js';

export interface ReviewFindingRepoDeps {
  repo: ReviewFindingRepository;
}

export class ReviewFindingRepo {
  constructor(private readonly deps: ReviewFindingRepoDeps) {}

  /**
   * Record all findings from a ReviewResult. Each row is bound to the
   * review's headSha (the finding_hash already incorporates headSha, so
   * re-reports at a new head produce distinct rows). Idempotent on
   * finding_hash: a re-report of the same finding returns the existing
   * row unchanged.
   */
  async recordReviewResult(args: {
    runId: string;
    prNumber: number | null;
    headSha: string;
    findings: readonly ReviewFinding[];
  }): Promise<readonly ReviewFindingRow[]> {
    const out: ReviewFindingRow[] = [];
    for (const finding of args.findings) {
      // findingHash already encodes headSha; we also persist headSha as
      // a column so the gate can filter by commit without parsing hashes.
      const row = await this.deps.repo.upsert({
        id: `rfind_${randomUUID()}`,
        findingHash: finding.findingHash,
        runId: args.runId,
        prNumber: args.prNumber,
        headSha: args.headSha,
        severity: finding.severity,
        category: categoryFor(finding.reviewer, finding.rule),
        filePath: finding.file,
        lineNumber: finding.lineStart,
        title: finding.title,
        description: finding.message,
        recommendation: finding.recommendation ?? null,
        blocking: finding.blocking,
        status: 'open',
      });
      out.push(row);
    }
    return out;
  }

  findById(id: string): Promise<ReviewFindingRow | null> {
    return this.deps.repo.findById(id);
  }

  findByHash(hash: string): Promise<ReviewFindingRow | null> {
    return this.deps.repo.findByHash(hash);
  }

  findByRun(runId: string): Promise<readonly ReviewFindingRow[]> {
    return this.deps.repo.findByRun(runId);
  }

  findByPr(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    return this.deps.repo.findByPr(prNumber);
  }

  findBlocking(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    return this.deps.repo.findBlockingByPr(prNumber);
  }

  setStatus(
    id: string,
    patch: {
      status?: FindingStatus;
      closedBy?: string | null;
      closeReason?: string | null;
      closedAt?: Date | null;
    },
  ): Promise<ReviewFindingRow> {
    return this.deps.repo.setStatus(id, patch);
  }
}

/**
 * Compute a coarse `category` column value from the reviewer class and
 * rule id. The DB stores this denormalized so the dashboard can filter
 * "all auth-related findings" without parsing rule ids.
 */
function categoryFor(reviewer: ReviewerClass, rule: string): string {
  if (reviewer === 'security') return `security:${rule.split('/')[0] ?? rule}`;
  return `code:${rule.split('/')[0] ?? rule}`;
}

/**
 * Recompute the canonical finding hash for a (runId, headSha, finding).
 * Exposed so the lifecycle service and tests can re-derive the hash
 * without reconstructing the full ReviewFinding.
 */
export function findingHashFor(args: {
  runId: string;
  headSha: string;
  reviewer: ReviewerClass;
  finding: Pick<ReviewFinding, 'rule' | 'file' | 'lineStart' | 'lineEnd' | 'message'>;
}): string {
  return computeFindingHash({
    runId: args.runId,
    headSha: args.headSha,
    reviewer: args.reviewer,
    rule: args.finding.rule,
    file: args.finding.file,
    lineStart: args.finding.lineStart,
    lineEnd: args.finding.lineEnd,
    message: args.finding.message,
  });
}

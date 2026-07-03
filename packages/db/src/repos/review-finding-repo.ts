/**
 * ReviewFinding repository — T-M8-003, spec §12.9 / §15.
 *
 * Owns persistence of review_findings rows. Contract:
 *
 *   - upsert() is idempotent on finding_hash: a re-report of the same
 *     finding (same run/head/reviewer/rule/file/lines/message) is a no-op.
 *   - findByRun() returns all findings for a review run, in insertion
 *     order — used by the runner to assemble the persisted bundle.
 *   - findBlockingByPr() returns only blocking, OPEN findings — the M9
 *     gate aggregator uses this to decide whether a PR can merge.
 *   - setStatus() is the low-level transition used by FindingLifecycleService.
 *
 * Note: the underlying review_findings table (packages/db/src/schema)
 * has no `version` column today; optimistic concurrency is enforced by
 * the lifecycle service via status precondition checks instead.
 */

import type { ReviewFinding as DbReviewFinding } from '../schema/review-findings.js';

export type FindingStatus = 'open' | 'fixed' | 'dismissed';

export interface NewReviewFindingInput {
  id: string;
  findingHash: string;
  runId: string | null;
  prNumber: number | null;
  headSha: string;
  severity: string;
  category: string;
  filePath: string | null;
  lineNumber: number | null;
  title: string;
  description: string;
  recommendation: string | null;
  blocking: boolean;
  status: FindingStatus;
}

export interface ReviewFindingRow extends DbReviewFinding {}

export interface ReviewFindingPatch {
  status?: FindingStatus;
  closedBy?: string | null;
  closeReason?: string | null;
  closedAt?: Date | null;
}

export interface ReviewFindingRepository {
  upsert(input: NewReviewFindingInput): Promise<ReviewFindingRow>;
  findById(id: string): Promise<ReviewFindingRow | null>;
  findByHash(findingHash: string): Promise<ReviewFindingRow | null>;
  findByRun(runId: string): Promise<readonly ReviewFindingRow[]>;
  findByPr(prNumber: number): Promise<readonly ReviewFindingRow[]>;
  findBlockingByPr(prNumber: number): Promise<readonly ReviewFindingRow[]>;
  setStatus(id: string, patch: ReviewFindingPatch): Promise<ReviewFindingRow>;
}

export class ReviewFindingNotFoundError extends Error {
  readonly findingId: string;
  constructor(findingId: string) {
    super(`review_finding not found: ${findingId}`);
    this.name = 'ReviewFindingNotFoundError';
    this.findingId = findingId;
  }
}

/**
 * In-memory implementation. Sufficient for unit tests and orchestrator
 * startup mode; a Postgres-backed implementation lands with the M11
 * persistence rollout and conforms to the same interface.
 */
export class InMemoryReviewFindingRepository implements ReviewFindingRepository {
  private readonly rows = new Map<string, ReviewFindingRow>();

  async upsert(input: NewReviewFindingInput): Promise<ReviewFindingRow> {
    const existing = await this.findByHash(input.findingHash);
    if (existing) {
      return { ...existing };
    }
    const now = new Date();
    const row: ReviewFindingRow = {
      id: input.id,
      findingHash: input.findingHash,
      runId: input.runId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      severity: input.severity,
      category: input.category,
      filePath: input.filePath,
      lineNumber: input.lineNumber,
      title: input.title,
      description: input.description,
      recommendation: input.recommendation,
      blocking: input.blocking,
      status: input.status,
      closedBy: null,
      closeReason: null,
      createdAt: now,
      closedAt: null,
    };
    this.rows.set(input.id, row);
    return { ...row };
  }

  async findById(id: string): Promise<ReviewFindingRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async findByHash(findingHash: string): Promise<ReviewFindingRow | null> {
    for (const row of this.rows.values()) {
      if (row.findingHash === findingHash) {
        return { ...row };
      }
    }
    return null;
  }

  async findByRun(runId: string): Promise<readonly ReviewFindingRow[]> {
    const out: ReviewFindingRow[] = [];
    for (const row of this.rows.values()) {
      if (row.runId === runId) {
        out.push({ ...row });
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }

  async findByPr(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    const out: ReviewFindingRow[] = [];
    for (const row of this.rows.values()) {
      if (row.prNumber === prNumber) {
        out.push({ ...row });
      }
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return out;
  }

  async findBlockingByPr(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    const all = await this.findByPr(prNumber);
    return all.filter((r) => r.blocking && r.status === 'open');
  }

  async setStatus(id: string, patch: ReviewFindingPatch): Promise<ReviewFindingRow> {
    const row = this.rows.get(id);
    if (!row) throw new ReviewFindingNotFoundError(id);
    const next: ReviewFindingRow = { ...row, ...stripUndefined(patch) };
    this.rows.set(id, next);
    return { ...next };
  }
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<T>;
}

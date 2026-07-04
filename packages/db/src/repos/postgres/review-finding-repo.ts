/**
 * Postgres-backed ReviewFindingRepository — Plan B Phase 1, spec §15.
 *
 * Same interface as the in-memory variant; persists against
 * `review_findings`. `upsert()` is idempotent on finding_hash via
 * `ON CONFLICT (finding_hash) DO NOTHING`-style logic — we first look
 * up by hash; if found, we return the existing row.
 */

import { and, eq } from 'drizzle-orm';
import { reviewFindings, type ReviewFinding } from '../../schema/review-findings.js';
import type { DrizzleDb } from '../../client.js';
import {
  ReviewFindingNotFoundError,
  type NewReviewFindingInput,
  type ReviewFindingPatch,
  type ReviewFindingRepository,
  type ReviewFindingRow,
} from '../review-finding-repo.js';

export class PostgresReviewFindingRepository implements ReviewFindingRepository {
  constructor(private readonly db: DrizzleDb) {}

  async upsert(input: NewReviewFindingInput): Promise<ReviewFindingRow> {
    const existing = await this.findByHash(input.findingHash);
    if (existing) return existing;
    const row = {
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
    };
    const inserted = await this.db.insert(reviewFindings).values(row).returning();
    return ((inserted[0] as ReviewFinding | undefined) ?? null) as ReviewFindingRow;
  }

  async findById(id: string): Promise<ReviewFindingRow | null> {
    const rows = await this.db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.id, id))
      .limit(1);
    return (rows[0] as ReviewFinding | undefined) ?? null;
  }

  async findByHash(findingHash: string): Promise<ReviewFindingRow | null> {
    const rows = await this.db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.findingHash, findingHash))
      .limit(1);
    return (rows[0] as ReviewFinding | undefined) ?? null;
  }

  async findByRun(runId: string): Promise<readonly ReviewFindingRow[]> {
    return await this.db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.runId, runId));
  }

  async findByPr(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    return await this.db
      .select()
      .from(reviewFindings)
      .where(eq(reviewFindings.prNumber, prNumber));
  }

  async findBlockingByPr(prNumber: number): Promise<readonly ReviewFindingRow[]> {
    return await this.db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.prNumber, prNumber),
          eq(reviewFindings.blocking, true),
          eq(reviewFindings.status, 'open'),
        ),
      );
  }

  async setStatus(id: string, patch: ReviewFindingPatch): Promise<ReviewFindingRow> {
    const setClause: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) {
      if (v !== undefined) {
        setClause[camelToColumn(k)] = v;
      }
    }
    const rows = await this.db
      .update(reviewFindings)
      .set(setClause)
      .where(eq(reviewFindings.id, id))
      .returning();
    const updated = (rows[0] as ReviewFinding | undefined) ?? null;
    if (!updated) throw new ReviewFindingNotFoundError(id);
    return updated;
  }
}

function camelToColumn(key: string): string {
  const map: Record<string, string> = {
    status: 'status',
    closedBy: 'closed_by',
    closeReason: 'close_reason',
    closedAt: 'closed_at',
  };
  return map[key] ?? key;
}

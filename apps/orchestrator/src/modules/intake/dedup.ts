/**
 * Intake deduplication — T-INTAKE-006, spec §12.0 / §15.
 *
 * dedup_key = source_type|external_id|content_hash
 *
 * - source_type: 'lark' | 'wecom' | 'github_issue' | 'github_discussion'
 * - external_id: platform-native message id (chat_id+message_id for IM,
 *   issue_number for github)
 * - content_hash: sha256 of canonicalized message text (trimmed, NFC
 *   normalized, ws-collapsed). Two messages with cosmetic whitespace
 *   differences still dedup.
 *
 * Within a configurable window (default 24h) the same dedup_key MUST
 * produce only one intake_session → only one issue. Repeated triggers
 * return the existing session's issue URL (HTTP 200 with existing_issue).
 *
 * Dedup state lives only in PostgreSQL `intake_sessions.dedup_key` (with
 * a unique constraint). The in-memory implementation here is for tests;
 * production wraps a SELECT/INSERT-with-ON-CONFLICT around the same
 * computeDedupKey function.
 */

import { createHash } from 'node:crypto';

export type IntakeSourceType = 'lark' | 'wecom' | 'github_issue' | 'github_discussion';

export interface DedupInput {
  sourceType: IntakeSourceType;
  externalId: string;
  /** The full message body the user sent, before any canonicalization. */
  content: string;
}

export interface DedupResolution {
  /** True when an existing session in-window was found. */
  duplicate: boolean;
  dedupKey: string;
  contentHash: string;
  /** When duplicate, the existing intake_session id and issue URL. */
  existingSessionId?: string;
  existingIssueUrl?: string | null;
  /** When duplicate, the timestamp the existing session was opened. */
  existingOpenedAt?: string;
}

export interface DedupStore {
  /**
   * Atomically insert-or-return for the dedup_key. Implementations MUST
   * be race-free (Postgres: INSERT ... ON CONFLICT (dedup_key) DO NOTHING
   * RETURNING; in-memory: synchronized Map lookup+set).
   *
   * Returns the row that won — either the new one (inserted=true) or
   * the pre-existing one (inserted=false).
   */
  claim(args: {
    dedupKey: string;
    windowMinutes: number;
    newSessionId: string;
    now: Date;
  }): Promise<{ inserted: boolean; sessionId: string; openedAt: Date; issueUrl: string | null }>;
}

export interface IntakeDeduplicator {
  resolve(input: DedupInput, args: { sessionId: string; now?: Date }): Promise<DedupResolution>;
}

export const DEFAULT_DEDUP_WINDOW_MINUTES = 24 * 60;

/** Trim + collapse internal whitespace + Unicode NFC for stable hashing. */
export function canonicalIntakeContent(text: string): string {
  return text.trim().replace(/\s+/gu, ' ').normalize('NFC');
}

export function hashIntakeContent(content: string): string {
  return createHash('sha256').update(canonicalIntakeContent(content)).digest('hex');
}

export function computeDedupKey(input: DedupInput): string {
  const contentHash = hashIntakeContent(input.content);
  return `${input.sourceType}|${input.externalId}|${contentHash}`;
}

export class Deduplicator implements IntakeDeduplicator {
  constructor(
    private readonly store: DedupStore,
    private readonly windowMinutes: number = DEFAULT_DEDUP_WINDOW_MINUTES,
  ) {}

  async resolve(
    input: DedupInput,
    args: { sessionId: string; now?: Date },
  ): Promise<DedupResolution> {
    const dedupKey = computeDedupKey(input);
    const contentHash = hashIntakeContent(input.content);
    const now = args.now ?? new Date();
    const result = await this.store.claim({
      dedupKey,
      windowMinutes: this.windowMinutes,
      newSessionId: args.sessionId,
      now,
    });
    if (result.inserted) {
      return { duplicate: false, dedupKey, contentHash };
    }
    return {
      duplicate: true,
      dedupKey,
      contentHash,
      existingSessionId: result.sessionId,
      existingIssueUrl: result.issueUrl,
      existingOpenedAt: result.openedAt.toISOString(),
    };
  }
}

/**
 * In-memory DedupStore. Used by unit tests; production swaps in a
 * Postgres-backed implementation that mirrors claim() semantics with
 * INSERT ... ON CONFLICT.
 *
 * Note: rows older than windowMinutes are ignored on lookup (treated as
 * if evicted) so a repeat trigger past the window can claim a fresh row.
 */
export class InMemoryDedupStore implements DedupStore {
  private readonly rows = new Map<
    string,
    { sessionId: string; openedAt: Date; issueUrl: string | null }
  >();

  async claim(args: {
    dedupKey: string;
    windowMinutes: number;
    newSessionId: string;
    now: Date;
  }): Promise<{ inserted: boolean; sessionId: string; openedAt: Date; issueUrl: string | null }> {
    const existing = this.rows.get(args.dedupKey);
    if (existing) {
      const windowMs = args.windowMinutes * 60_000;
      const ageMs = args.now.getTime() - existing.openedAt.getTime();
      if (ageMs < windowMs) {
        return {
          inserted: false,
          sessionId: existing.sessionId,
          openedAt: existing.openedAt,
          issueUrl: existing.issueUrl,
        };
      }
      // Evict expired row so the new claim can take its place.
      this.rows.delete(args.dedupKey);
    }
    const row = { sessionId: args.newSessionId, openedAt: args.now, issueUrl: null };
    this.rows.set(args.dedupKey, row);
    return { inserted: true, ...row };
  }

  /** Test helper: pretend an issue URL was attached to the existing row. */
  attachIssueUrl(dedupKey: string, url: string): void {
    const row = this.rows.get(dedupKey);
    if (row) row.issueUrl = url;
  }
}

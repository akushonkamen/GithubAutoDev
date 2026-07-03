/**
 * RetentionScheduler — T-M10-005, spec §11 / §15.
 *
 * Walks a set of artifacts and partitions them into buckets by tier.
 * Artifacts older than the tier's retention window are reported as
 * expired; the caller decides whether to archive or tombstone them.
 *
 * The scheduler does NOT delete artifacts — it only reports expiry so
 * the audit chain can record the decision. Actual removal happens
 * downstream via an `artifact.expired` event that a separate consumer
 * turns into a tombstone write (spec §15: never actually DELETE).
 */

import { type AccessTier, tierRank } from './access-policy.js';
import type { Artifact } from './index.js';

/**
 * Minimal sink for expiry events. Production wires this to the bus;
 * the artifacts package stays free of a hard `@cgao/eventbus` dep so
 * it can be reused outside the orchestrator.
 */
export interface ExpirySink {
  emitExpired(event: {
    key: string;
    repo: string;
    tier: AccessTier;
    ageDays: number;
    retentionDays: number;
  }): Promise<void> | void;
}

export interface RetentionPolicy {
  /** Days each tier is retained before expiry. */
  readonly retentionDays: Readonly<Record<AccessTier, number>>;
}

export const DEFAULT_RETENTION_POLICY: RetentionPolicy = {
  retentionDays: {
    public_summary: 90,
    internal_log: 180,
    security_sensitive: 365,
    audit_restricted: 2555, // 7 years
  },
};

export interface ExpiredArtifact {
  key: string;
  repo: string;
  tier: AccessTier;
  createdAt: string;
  ageDays: number;
}

export interface RetentionTickInput {
  artifacts: readonly Artifact[];
  tiersForArtifacts: ReadonlyMap<string, AccessTier>;
  /** Default now() = current time. */
  now?: Date;
}

export interface RetentionTickResult {
  expired: readonly ExpiredArtifact[];
  retained: number;
}

export class RetentionScheduler {
  constructor(
    private readonly policy: RetentionPolicy = DEFAULT_RETENTION_POLICY,
    private readonly sink?: ExpirySink,
  ) {}

  async tick(input: RetentionTickInput): Promise<RetentionTickResult> {
    const now = (input.now ?? new Date()).getTime();
    const expired: ExpiredArtifact[] = [];
    for (const a of input.artifacts) {
      const tier = input.tiersForArtifacts.get(a.key) ?? 'internal_log';
      const ageDays = Math.max(0, (now - new Date(a.createdAt).getTime()) / 86_400_000);
      const cutoff = this.policy.retentionDays[tier] ?? Number.POSITIVE_INFINITY;
      if (ageDays > cutoff) {
        expired.push({
          key: a.key,
          repo: a.repo,
          tier,
          createdAt: a.createdAt,
          ageDays,
        });
        await this.sink?.emitExpired({
          key: a.key,
          repo: a.repo,
          tier,
          ageDays,
          retentionDays: cutoff,
        });
      }
    }
    return { expired, retained: input.artifacts.length - expired.length };
  }
}

export { tierRank };

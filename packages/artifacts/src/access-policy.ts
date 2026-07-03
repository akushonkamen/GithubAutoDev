/**
 * ArtifactAccessPolicy — T-M10-005, spec §11 / §15.
 *
 * Tier-based access control for artifacts. Every artifact is classified
 * into one of four tiers; every principal carries a clearance level.
 * canRead() returns true iff the principal's clearance is at or above
 * the artifact's tier.
 *
 * Tiers (ascending sensitivity):
 *
 *   public_summary     — anyone (incl. external actors)
 *   internal_log       — operator / internal bot
 *   security_sensitive — security reviewers + auditors
 *   audit_restricted   — auditors only (chain-of-custody records)
 */

import type { Artifact } from './index.js';

export type AccessTier =
  | 'public_summary'
  | 'internal_log'
  | 'security_sensitive'
  | 'audit_restricted';

export interface Principal {
  /** Identity string (GitHub login, internal role, etc.). */
  readonly id: string;
  /** Highest tier this principal can read. */
  readonly clearance: AccessTier;
}

const TIER_RANK: Record<AccessTier, number> = {
  public_summary: 0,
  internal_log: 1,
  security_sensitive: 2,
  audit_restricted: 3,
};

export interface AccessDecision {
  allowed: boolean;
  tier: AccessTier;
  clearance: AccessTier;
  reason: string;
}

/**
 * Classifier — map an artifact's metadata to an AccessTier. Default
 * rule: artifacts whose content includes redaction findings are
 * security_sensitive; raw_payload artifacts default to internal_log;
 * everything else defaults to public_summary. Callers can override.
 */
export type ArtifactClassifier = (artifact: Artifact) => AccessTier;

export const DEFAULT_CLASSIFIER: ArtifactClassifier = (a) => {
  // Heuristic: review/spec/plan artifacts are summary-shaped.
  switch (a.kind) {
    case 'spec':
    case 'plan':
    case 'review':
      return 'public_summary';
    case 'implementation_note':
      return 'internal_log';
    case 'raw_payload':
      return 'security_sensitive';
    default:
      return 'internal_log';
  }
};

export class ArtifactAccessPolicy {
  constructor(private readonly classifier: ArtifactClassifier = DEFAULT_CLASSIFIER) {}

  classify(artifact: Artifact): AccessTier {
    return this.classifier(artifact);
  }

  canRead(args: { principal: Principal; artifact: Artifact }): AccessDecision {
    const tier = this.classifier(args.artifact);
    const allowed = TIER_RANK[args.principal.clearance] >= TIER_RANK[tier];
    return {
      allowed,
      tier,
      clearance: args.principal.clearance,
      reason: allowed ? 'cleared' : 'insufficient-clearance',
    };
  }
}

/** Convenience: tier ranking exported for tests / callers. */
export function tierRank(tier: AccessTier): number {
  return TIER_RANK[tier];
}

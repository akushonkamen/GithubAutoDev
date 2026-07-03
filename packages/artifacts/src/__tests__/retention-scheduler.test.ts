/**
 * T-M10-005 RetentionScheduler — expiry detection + event emission.
 */

import { describe, expect, it } from 'vitest';
import type { AccessTier } from '../access-policy.js';
import {
  type Artifact,
  type ExpirySink,
  type RetentionPolicy,
  RetentionScheduler,
  computeArtifactKey,
} from '../index.js';

function artifactAt(kind: Artifact['kind'], daysAgo: number): Artifact {
  const ms = Date.now() - daysAgo * 86_400_000;
  return {
    kind,
    key: computeArtifactKey(`${kind}:${daysAgo}`),
    content: `${kind}:${daysAgo}`,
    repo: 'cgao/test',
    runId: null,
    createdAt: new Date(ms).toISOString(),
  };
}

describe('T-M10-005 RetentionScheduler', () => {
  it('reports expired artifacts grouped by tier', async () => {
    const policy: RetentionPolicy = {
      retentionDays: {
        public_summary: 1,
        internal_log: 10,
        security_sensitive: 100,
        audit_restricted: 1000,
      },
    };
    const sched = new RetentionScheduler(policy);
    const a1 = artifactAt('spec', 5); // public_summary, expired
    const a2 = artifactAt('implementation_note', 5); // internal_log, retained
    const a3 = artifactAt('raw_payload', 5); // security_sensitive, retained
    const tiers = new Map<string, AccessTier>([
      [a1.key, 'public_summary'],
      [a2.key, 'internal_log'],
      [a3.key, 'security_sensitive'],
    ]);
    const out = await sched.tick({ artifacts: [a1, a2, a3], tiersForArtifacts: tiers });
    expect(out.expired.length).toBe(1);
    expect(out.expired[0]?.key).toBe(a1.key);
    expect(out.retained).toBe(2);
  });

  it('emits artifact.expired events for expired rows', async () => {
    const seen: string[] = [];
    const sink: ExpirySink = {
      emitExpired(e) {
        seen.push(e.key);
      },
    };
    const sched = new RetentionScheduler(
      {
        retentionDays: {
          public_summary: 1,
          internal_log: 1,
          security_sensitive: 1,
          audit_restricted: 1,
        },
      },
      sink,
    );
    const a = artifactAt('spec', 30);
    await sched.tick({
      artifacts: [a],
      tiersForArtifacts: new Map([[a.key, 'public_summary' as AccessTier]]),
    });
    expect(seen).toEqual([a.key]);
  });

  it('does not delete — only reports (caller responsibility)', async () => {
    const sched = new RetentionScheduler();
    const a = artifactAt('raw_payload', 1_000);
    const out = await sched.tick({
      artifacts: [a],
      tiersForArtifacts: new Map([[a.key, 'security_sensitive' as AccessTier]]),
    });
    // security_sensitive default is 365d; 1000 days > 365 -> expired
    expect(out.expired.length).toBe(1);
  });
});

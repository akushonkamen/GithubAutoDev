/**
 * T-M10-005 ArtifactAccessPolicy — tiered access control.
 */

import { describe, expect, it } from 'vitest';
import {
  type Artifact,
  ArtifactAccessPolicy,
  type Principal,
  computeArtifactKey,
} from '../index.js';

function artifact(kind: Artifact['kind'], content = 'hello'): Artifact {
  const c = content;
  return {
    kind,
    key: computeArtifactKey(c),
    content: c,
    repo: 'cgao/test',
    runId: 'run_1',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('T-M10-005 ArtifactAccessPolicy', () => {
  it('classifies artifacts by default classifier', () => {
    const p = new ArtifactAccessPolicy();
    expect(p.classify(artifact('spec'))).toBe('public_summary');
    expect(p.classify(artifact('plan'))).toBe('public_summary');
    expect(p.classify(artifact('review'))).toBe('public_summary');
    expect(p.classify(artifact('implementation_note'))).toBe('internal_log');
    expect(p.classify(artifact('raw_payload'))).toBe('security_sensitive');
  });

  it('allows external actor to read public_summary only', () => {
    const p = new ArtifactAccessPolicy();
    const external: Principal = { id: 'ext-1', clearance: 'public_summary' };
    const ok = p.canRead({ principal: external, artifact: artifact('spec') });
    expect(ok.allowed).toBe(true);
    const blocked = p.canRead({ principal: external, artifact: artifact('raw_payload') });
    expect(blocked.allowed).toBe(false);
    expect(blocked.tier).toBe('security_sensitive');
    expect(blocked.reason).toBe('insufficient-clearance');
  });

  it('blocks external actor from audit_restricted regardless of artifact kind', () => {
    const external: Principal = { id: 'ext-2', clearance: 'public_summary' };
    const auditor: Principal = { id: 'audit-1', clearance: 'audit_restricted' };
    const classifier = () => 'audit_restricted' as const;
    const strict = new ArtifactAccessPolicy(classifier);
    expect(strict.canRead({ principal: external, artifact: artifact('spec') }).allowed).toBe(false);
    expect(strict.canRead({ principal: auditor, artifact: artifact('spec') }).allowed).toBe(true);
  });

  it('honors custom classifiers (security_sensitive floor)', () => {
    const p = new ArtifactAccessPolicy(() => 'security_sensitive');
    const operator: Principal = { id: 'op', clearance: 'security_sensitive' };
    const internal: Principal = { id: 'in', clearance: 'internal_log' };
    expect(p.canRead({ principal: operator, artifact: artifact('spec') }).allowed).toBe(true);
    expect(p.canRead({ principal: internal, artifact: artifact('spec') }).allowed).toBe(false);
  });
});

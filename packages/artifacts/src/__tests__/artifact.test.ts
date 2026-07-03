import { describe, expect, it } from 'vitest';
import { artifactSchema, computeArtifactKey } from '../index.js';

describe('@cgao/artifacts', () => {
  it('computes sha256 content key', () => {
    const key = computeArtifactKey('hello');
    expect(key).toBe('sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  });

  it('different inputs produce different keys', () => {
    expect(computeArtifactKey('a')).not.toBe(computeArtifactKey('b'));
  });

  it('validates a well-formed artifact', () => {
    const artifact = {
      kind: 'spec' as const,
      key: computeArtifactKey('spec-body'),
      content: 'spec-body',
      repo: 'owner/name',
      runId: null,
      createdAt: '2026-07-03T10:00:00.000Z',
    };
    expect(artifactSchema.safeParse(artifact).success).toBe(true);
  });

  it('rejects an artifact whose key does not match content', () => {
    const bad = {
      kind: 'spec' as const,
      key: 'sha256:deadbeef',
      content: 'spec-body',
      repo: 'owner/name',
      runId: null,
      createdAt: '2026-07-03T10:00:00.000Z',
    };
    expect(artifactSchema.safeParse(bad).success).toBe(false);
  });
});

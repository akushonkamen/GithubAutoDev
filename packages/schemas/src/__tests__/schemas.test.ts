/**
 * Schemas package smoke test.
 *
 * Locks the M0 contract: cgaoConfigSchema accepts a v1 config and
 * applies defaults; artifactRefSchema enforces the sha256 format.
 * Full field-by-field coverage lands with T-M1-* once the modules
 * that consume these schemas are wired.
 */

import { describe, expect, it } from 'vitest';
import { artifactRefSchema, cgaoConfigSchema } from '../index.js';

describe('cgaoConfigSchema', () => {
  it('parses a minimal v1 config and fills gate defaults', () => {
    const parsed = cgaoConfigSchema.parse({
      schema_version: 1,
      repo: { name: 'cgao/test' },
      gates: {},
      runners: {
        trusted_control: { label: 'cgao-trusted-runner', allowed_secrets: [] },
        untrusted_code: { label: 'cgao-untrusted-runner' },
      },
    });
    expect(parsed.gates.spec_sha).toBe(true);
    expect(parsed.gates.head_sha).toBe(true);
    expect(parsed.runners.trusted_control.label).toBe('cgao-trusted-runner');
  });

  it('rejects an unknown schema_version', () => {
    expect(() =>
      cgaoConfigSchema.parse({
        schema_version: 2,
        repo: { name: 'cgao/test' },
      }),
    ).toThrow();
  });

  it('rejects an empty repo name', () => {
    expect(() =>
      cgaoConfigSchema.parse({
        schema_version: 1,
        repo: { name: '' },
      }),
    ).toThrow();
  });
});

describe('artifactRefSchema', () => {
  it('accepts a well-formed reference', () => {
    const ref = artifactRefSchema.parse({
      kind: 'requirement_spec',
      sha256: 'a'.repeat(64),
      size: 1024,
      uri: 's3://cgao-artifacts/abc',
      generated_at: '2026-07-03T00:00:00Z',
      generator: 'mod_analysis',
    });
    expect(ref.kind).toBe('requirement_spec');
  });

  it('rejects a malformed sha256', () => {
    expect(() =>
      artifactRefSchema.parse({
        kind: 'requirement_spec',
        sha256: 'deadbeef',
        size: 1024,
        uri: 's3://cgao-artifacts/abc',
        generated_at: '2026-07-03T00:00:00Z',
        generator: 'mod_analysis',
      }),
    ).toThrow();
  });

  it('rejects an unknown artifact kind', () => {
    expect(() =>
      artifactRefSchema.parse({
        kind: 'unknown_kind',
        sha256: 'a'.repeat(64),
        size: 1,
        uri: 'https://example.com/x',
        generated_at: '2026-07-03T00:00:00Z',
        generator: 'mod_analysis',
      }),
    ).toThrow();
  });
});

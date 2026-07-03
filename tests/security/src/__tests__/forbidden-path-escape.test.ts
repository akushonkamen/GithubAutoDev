/**
 * Forbidden path escape regression — attack-scenarios/, spec §6 / §13.3 / §21.
 *
 * Three fixtures covering the canonical path-escape attacks against
 * the PathWritePolicy:
 *
 *   - Symlink escape: a symlink inside an allowed dir points at a
 *     forbidden dir; the write must be rejected.
 *   - Absolute path trickery: an absolute path outside the workspace
 *     root, claimed to be "allowed".
 *   - `..` traversal: a path that climbs out of the workspace via
 *     nested `..` segments.
 *
 * Each fixture must be rejected with decision='POLICY_DENIED'.
 */

import { PathWritePolicy } from '@cgao/runner-broker';
import { describe, expect, it } from 'vitest';

const WORKSPACE = '/repo';

function makePolicy(): PathWritePolicy {
  return new PathWritePolicy({
    workspaceRoot: WORKSPACE,
    allowedPaths: ['src/features/**'],
    forbiddenPaths: ['.cgao/**', '.github/**', 'secrets/**'],
  });
}

describe('T-M5-009 forbidden path escape (spec §6 / §13.3 / §21)', () => {
  it('rejects symlink escape from allowed dir to forbidden dir', () => {
    const policy = makePolicy();
    // Symlink at src/features/x points at /repo/.cgao/payload.
    const symlinkPath = `${WORKSPACE}/src/features/escape-link`;
    const symlinkTarget = `${WORKSPACE}/.cgao/payload`;
    const result = policy.isAllowed(symlinkPath, symlinkTarget);
    expect(result.decision).toBe('POLICY_DENIED');
    expect(result.reasons.join('\n')).toMatch(/forbidden prefix|symlink escapes/);
  });

  it('rejects absolute path outside workspace root', () => {
    const policy = makePolicy();
    const malicious = '/etc/passwd';
    const result = policy.isAllowed(malicious);
    expect(result.decision).toBe('POLICY_DENIED');
    expect(result.reasons.join('\n')).toMatch(/outside workspace root/);
  });

  it('rejects `..` traversal that escapes the workspace', () => {
    const policy = makePolicy();
    const traversal = `${WORKSPACE}/src/features/../../.cgao/payload`;
    const result = policy.isAllowed(traversal);
    expect(result.decision).toBe('POLICY_DENIED');
    // Traversal produces either (a) the '..' segment is detected, or
    // (b) the normalized path lands in .cgao/ — both are denials.
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('allows a benign write inside the allowed dir', () => {
    const policy = makePolicy();
    const result = policy.isAllowed(`${WORKSPACE}/src/features/billing/invoice.ts`);
    expect(result.decision).toBe('allow');
  });
});

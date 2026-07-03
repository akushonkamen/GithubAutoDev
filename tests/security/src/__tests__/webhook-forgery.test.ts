/**
 * Forgery regression — attack-scenarios/webhook-replay.md §4.2.
 *
 * Verifies `verifyGithubSignature` rejects every forged-signature
 * variant in the blue-team drill list. T-M1-001 / T-M1-006 wire this
 * into the live endpoint; here we lock the verifier itself.
 */

import { createHmac } from 'node:crypto';
import { verifyGithubSignature } from '@cgao/github';
import { describe, expect, it } from 'vitest';

const SECRET = 'correct horse battery staple';
const BODY = JSON.stringify({
  action: 'closed',
  pull_request: { number: 42, head: { sha: 'abc' } },
});

function sign(secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(BODY).digest('hex')}`;
}

describe('webhook forgery / signature verification', () => {
  it('accepts a well-formed signature', () => {
    expect(verifyGithubSignature(BODY, sign(SECRET), SECRET)).toBe(true);
  });

  it('rejects a missing signature header', () => {
    expect(verifyGithubSignature(BODY, '', SECRET)).toBe(false);
    expect(verifyGithubSignature(BODY, 'sha256=', SECRET)).toBe(false);
  });

  it('rejects a wrong-secret signature', () => {
    expect(verifyGithubSignature(BODY, sign('wrong secret'), SECRET)).toBe(false);
  });

  it('rejects legacy sha1= prefix (downgrade attempt)', () => {
    const sha1 = `sha1=${createHmac('sha1', SECRET).update(BODY).digest('hex')}`;
    expect(verifyGithubSignature(BODY, sha1, SECRET)).toBe(false);
  });

  it('rejects a signature for a different body (1-byte mutation)', () => {
    const mutated = BODY.replace('"closed"', '"open"');
    expect(verifyGithubSignature(mutated, sign(SECRET), SECRET)).toBe(false);
  });

  it('rejects cross-platform secret reuse', () => {
    // Lark-style prefix-less or different-length secret must not validate.
    expect(verifyGithubSignature(BODY, sign('lark_app_secret_xyz'), SECRET)).toBe(false);
  });
});

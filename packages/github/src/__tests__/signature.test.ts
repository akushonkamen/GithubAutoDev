import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyGithubSignature } from '../index.js';

describe('@cgao/github signature verification', () => {
  const secret = 'test-secret';

  function sign(body: string): string {
    return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  }

  it('accepts a valid signature', () => {
    const body = '{"action":"opened"}';
    expect(verifyGithubSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const body = '{"action":"opened"}';
    expect(verifyGithubSignature(body, sign(body), 'other-secret')).toBe(false);
  });

  it('rejects tampered body', () => {
    const body = '{"action":"opened"}';
    expect(verifyGithubSignature('{"action":"closed"}', sign(body), secret)).toBe(false);
  });

  it('rejects malformed header', () => {
    expect(verifyGithubSignature('{}', 'not-a-signature', secret)).toBe(false);
  });
});

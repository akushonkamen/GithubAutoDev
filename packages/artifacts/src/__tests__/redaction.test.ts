/**
 * Redaction baseline regression — T-M2-005, spec §11 / §20.
 *
 * Verifies that secrets, PII, and high-entropy strings are scrubbed
 * before content reaches a non-volatile store or a GitHub comment.
 */

import { describe, expect, it } from 'vitest';
import { isSecuritySensitive, redact } from '../redaction.js';

describe('redact (T-M2-005)', () => {
  it('passes through clean text untouched', () => {
    const r = redact('hello world');
    expect(r.redacted).toBe('hello world');
    expect(r.findings).toEqual([]);
    expect(r.classification).toBe('clean');
  });

  it('redacts GitHub PATs', () => {
    const r = redact('my token is ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890 thanks');
    expect(r.redacted).not.toContain('ghp_');
    expect(r.findings.some((f) => f.kind === 'github_pat')).toBe(true);
    expect(r.classification).toBe('security_sensitive');
  });

  it('redacts AWS access key ids', () => {
    const r = redact('use AKIAIOSFODNN7EXAMPLE for the bucket');
    expect(r.redacted).toContain('[REDACTED:aws_access_key]');
    expect(r.findings.some((f) => f.kind === 'aws_access_key')).toBe(true);
  });

  it('redacts Authorization Bearer tokens', () => {
    const r = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.adL9._signature');
    expect(r.redacted).not.toContain('eyJhbGciOiJIUzI1NiJ9');
    expect(r.findings.some((f) => f.kind === 'bearer_token')).toBe(true);
  });

  it('redacts env-style SECRET=value', () => {
    const r = redact('PASSWORD=super-secret-pw@host/db');
    expect(r.findings.some((f) => f.kind === 'env_secret')).toBe(true);
    expect(r.classification).toBe('security_sensitive');
  });

  it('redacts PEM private key blocks', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----
MIIEpAIBAAKCAQEA1234567890abcdefghijklmnopqrstuvwxyz
-----END RSA PRIVATE KEY-----`;
    const r = redact(`key: ${pem}`);
    expect(r.findings.some((f) => f.kind === 'private_key')).toBe(true);
    expect(r.redacted).not.toContain('MIIEpAIBAAKCAQEA');
  });

  it('redacts emails', () => {
    const r = redact('contact me at alice@example.com please');
    expect(r.findings.some((f) => f.kind === 'email')).toBe(true);
  });

  it('redacts Luhn-valid credit-card-shaped digit runs', () => {
    // 4242 4242 4242 4242 is the canonical Stripe test card (Luhn-valid).
    const r = redact('card=4242 4242 4242 4242');
    expect(r.findings.some((f) => f.kind === 'credit_card')).toBe(true);
  });

  it('flags high-entropy base64 strings of length >= 20', () => {
    const r = redact('token: Z9hJ3kLp2mNqR7sTvWXyZ1bCdEfGhIjKlMnOpQr');
    expect(r.findings.some((f) => f.kind === 'high_entropy')).toBe(true);
  });

  it('does NOT flag ordinary English text as high entropy', () => {
    const r = redact('the quick brown fox jumps over the lazy dog');
    expect(r.classification).toBe('clean');
  });

  it('produces stable sha256 fingerprints for audit', () => {
    const r1 = redact('token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890');
    const r2 = redact('token ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890');
    expect(r1.findings[0]?.fingerprint).toBe(r2.findings[0]?.fingerprint);
    expect(r1.findings[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('isSecuritySensitive returns true when any finding exists', () => {
    expect(isSecuritySensitive('all clean here')).toBe(false);
    expect(isSecuritySensitive('ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890')).toBe(true);
  });

  it('classification marks security_sensitive artifacts so callers can skip GitHub comment write', () => {
    const r = redact('leaked: ghp_aBcDeFgHiJkLmNoPqRsTuVwXyZ1234567890');
    expect(r.classification).toBe('security_sensitive');
    // Caller code: if (r.classification === 'security_sensitive') skip comment;
  });
});

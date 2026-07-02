/**
 * Smoke test: assert that the security fixture corpus is non-empty and
 * that fixtures themselves don't accidentally contain real secrets.
 *
 * Per docs/security hard invariants (SECURITY.md):
 *  - FORBIDDEN_SECRET_PATTERNS must never match in fixture strings.
 *
 * This is the minimum stub of the security regression test framework
 * (T-M0-004). Real prompt-injection / replay / spoofing regression tests
 * land in T-INTAKE-010 / T-INTAKE-011 against the actual intake pipeline.
 */
import { describe, expect, it } from 'vitest';
import {
  FORBIDDEN_SECRET_PATTERNS,
  PROMPT_INJECTION_FIXTURES,
  SPOOFING_FIXTURES,
} from '../fixtures.js';

describe('security fixture corpus (T-M0-004)', () => {
  it('prompt injection corpus is non-empty', () => {
    expect(PROMPT_INJECTION_FIXTURES.length).toBeGreaterThan(0);
  });

  it('spoofing corpus is non-empty', () => {
    expect(SPOOFING_FIXTURES.length).toBeGreaterThan(0);
  });

  it('no fixture string matches forbidden secret patterns', () => {
    const all = [
      ...PROMPT_INJECTION_FIXTURES,
      ...SPOOFING_FIXTURES.flatMap((f) => [f.name, f.description, JSON.stringify(f.payload)]),
    ];
    for (const s of all) {
      for (const re of FORBIDDEN_SECRET_PATTERNS) {
        expect(re.test(s), `fixture matched forbidden pattern: ${re.source}`).toBe(false);
      }
    }
  });
});

/**
 * Prompt injection regression — attack-scenarios/prompt-injection.md,
 * spec §6.3, §12.0, §12.11.
 *
 * The defense is layered: (1) user content stays in untrusted
 * envelope; (2) authoritative actions are decided by policy, not by
 * LLM assertion; (3) protected-files touches force `needs_review`.
 *
 * This test locks the *policy* leg. The orchestrator (M2) is what
 * actually enforces "LLM cannot short-circuit"; here we ensure the
 * policy evaluator never returns `allow` for protected-file touches
 * regardless of input.
 */

import { evaluatePolicy } from '@cgao/policy';
import { PROMPT_INJECTION_FIXTURES } from '@cgao/test-utils';
import { describe, expect, it } from 'vitest';

describe('prompt injection — policy leg', () => {
  it('forces needs_review whenever any protected file is touched', () => {
    for (const body of PROMPT_INJECTION_FIXTURES) {
      const decision = evaluatePolicy({
        repo: 'cgao/test',
        runId: 'r1',
        protectedFilesTouched: ['.github/workflows/ci.yml'],
      });
      expect(decision, `body=${body.slice(0, 40)}`).toBe('needs_review');
    }
  });

  it('does not change decision based on issue/PR text volume (policy is content-blind at M0)', () => {
    const baseline = evaluatePolicy({
      repo: 'cgao/test',
      runId: 'r1',
      protectedFilesTouched: [],
    });
    // Future M2 policy changes that start reading user content must
    // update this test deliberately.
    for (const _body of PROMPT_INJECTION_FIXTURES) {
      const decision = evaluatePolicy({
        repo: 'cgao/test',
        runId: 'r1',
        protectedFilesTouched: [],
      });
      expect(decision).toBe(baseline);
    }
  });
});

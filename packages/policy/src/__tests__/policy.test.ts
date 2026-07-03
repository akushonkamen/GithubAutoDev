import { describe, expect, it } from 'vitest';
import { type PolicyContext, evaluatePolicy } from '../index.js';

describe('@cgao/policy evaluatePolicy (M0 stub)', () => {
  it('allows an empty context', () => {
    const ctx: PolicyContext = { repo: 'owner/name', runId: null };
    expect(evaluatePolicy(ctx)).toBe('allow');
  });

  it('forces review when protected files are touched', () => {
    const ctx: PolicyContext = {
      repo: 'owner/name',
      runId: 'run-1',
      protectedFilesTouched: ['.cgao.yml'],
    };
    expect(evaluatePolicy(ctx)).toBe('needs_review');
  });
});

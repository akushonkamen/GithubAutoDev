/**
 * HashBindingService + GateGuard + classifyStaleness — T-M2-006.
 */

import { describe, expect, it } from 'vitest';
import { type BoundAction, GateGuard, HashBindingService, classifyStaleness } from '../gates.js';

const shas = (overrides: Partial<BoundAction['shas']> = {}): BoundAction['shas'] => ({
  specSha: 'spec-sha-1',
  planSha: 'plan-sha-1',
  approvalSha: 'approval-sha-1',
  headSha: 'head-sha-1',
  baseSha: 'base-sha-1',
  issueSnapshotSha: 'issue-sha-1',
  ...overrides,
});

describe('HashBindingService.bind (T-M2-006)', () => {
  it('binds a spec action with only issueSnapshotSha', () => {
    const svc = new HashBindingService();
    const a = svc.bind({
      kind: 'spec',
      generation: 1,
      shas: shas({
        specSha: undefined,
        planSha: undefined,
        approvalSha: undefined,
        headSha: undefined,
        baseSha: undefined,
      }),
    });
    expect(a.kind).toBe('spec');
    expect(a.shas.issueSnapshotSha).toBe('issue-sha-1');
  });

  it('binds a plan action with issueSnapshotSha + specSha', () => {
    const svc = new HashBindingService();
    const a = svc.bind({
      kind: 'plan',
      generation: 1,
      shas: shas({ approvalSha: undefined, headSha: undefined, baseSha: undefined }),
    });
    expect(a.shas.specSha).toBe('spec-sha-1');
  });

  it('throws on missing required shas', () => {
    const svc = new HashBindingService();
    expect(() => svc.bind({ kind: 'approval', generation: 1, shas: { specSha: 'x' } })).toThrow(
      /missing required shas/u,
    );
  });

  it('binds a merge action with head + approval', () => {
    const svc = new HashBindingService();
    const a = svc.bind({
      kind: 'merge',
      generation: 1,
      shas: shas({
        issueSnapshotSha: undefined,
        specSha: undefined,
        planSha: undefined,
        baseSha: undefined,
      }),
    });
    expect(a.shas.approvalSha).toBe('approval-sha-1');
    expect(a.shas.headSha).toBe('head-sha-1');
  });
});

describe('GateGuard.check (T-M2-006)', () => {
  const guard = new GateGuard();

  it('allows when generation matches and shas are current', () => {
    const action: BoundAction = { kind: 'merge', generation: 3, shas: shas() };
    const r = guard.check({
      action,
      currentGeneration: 3,
      currentHeadSha: 'head-sha-1',
      currentIssueSnapshotSha: 'issue-sha-1',
    });
    expect(r.decision).toBe('allow');
    expect(r.reasons).toEqual([]);
  });

  it('denies when action generation < current generation', () => {
    const action: BoundAction = { kind: 'spec', generation: 1, shas: shas() };
    const r = guard.check({
      action,
      currentGeneration: 2,
      currentIssueSnapshotSha: 'issue-sha-1',
    });
    expect(r.decision).toBe('deny');
    expect(r.reasons.some((x) => x.includes('stale generation'))).toBe(true);
  });

  it('denies when PR head_sha has moved (test bound to old head)', () => {
    const action: BoundAction = {
      kind: 'test',
      generation: 1,
      shas: shas({ headSha: 'old-head' }),
    };
    const r = guard.check({
      action,
      currentGeneration: 1,
      currentHeadSha: 'new-head',
    });
    expect(r.decision).toBe('deny');
    expect(r.reasons.some((x) => x.includes('stale head_sha'))).toBe(true);
  });

  it('denies when issue snapshot moved (spec bound to old issue)', () => {
    const action: BoundAction = {
      kind: 'spec',
      generation: 1,
      shas: shas({ issueSnapshotSha: 'old-issue' }),
    };
    const r = guard.check({
      action,
      currentGeneration: 1,
      currentIssueSnapshotSha: 'new-issue',
    });
    expect(r.decision).toBe('deny');
    expect(r.reasons.some((x) => x.includes('stale issue_snapshot_sha'))).toBe(true);
  });

  it('denies when required sha is missing', () => {
    const action: BoundAction = {
      kind: 'approval',
      generation: 1,
      shas: { specSha: 'only-spec' },
    };
    const r = guard.check({ action, currentGeneration: 1 });
    expect(r.decision).toBe('deny');
    expect(r.reasons.some((x) => x.includes('missing required sha'))).toBe(true);
  });
});

describe('classifyStaleness (T-M2-006)', () => {
  it('returns fresh when event generation equals current', () => {
    const r = classifyStaleness({ eventGeneration: 2, currentGeneration: 2 });
    expect(r.stale).toBe(false);
    expect(r.reason).toBe('fresh');
  });

  it('returns old_generation when event generation < current', () => {
    const r = classifyStaleness({ eventGeneration: 1, currentGeneration: 2 });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe('old_generation');
  });

  it('returns old_head_sha when PR synchronized', () => {
    const r = classifyStaleness({
      eventHeadSha: 'aaa',
      currentHeadSha: 'bbb',
      currentGeneration: 1,
    });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe('old_head_sha');
  });

  it('returns old_issue_snapshot when issue material changed', () => {
    const r = classifyStaleness({
      eventIssueSnapshotSha: 'old',
      currentIssueSnapshotSha: 'new',
      currentGeneration: 1,
    });
    expect(r.stale).toBe(true);
    expect(r.reason).toBe('old_issue_snapshot');
  });

  it('returns fresh when event generation is null', () => {
    const r = classifyStaleness({ eventGeneration: null, currentGeneration: 1 });
    expect(r.stale).toBe(false);
  });
});

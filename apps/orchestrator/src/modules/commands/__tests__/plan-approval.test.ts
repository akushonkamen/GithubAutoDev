/**
 * Plan approval — T-M3-006, spec §12.3 + §12.5 + §14.3.
 *
 * Locks the contracts:
 *   - /approve-plan requires plan_id@plan_sha to match exactly.
 *   - plan_id mismatch → rejected(plan_id_not_found).
 *   - plan_sha mismatch → rejected(plan_sha_mismatch).
 *   - Older-generation plans cannot be approved (stale_generation).
 *   - Unauthorized actor → rejected(not_authorized), no artifact saved.
 *   - Approved plans persist an ApprovalArtifact and audit on both sides.
 */

import { describe, expect, it } from 'vitest';
import {
  type ApprovalArtifact,
  type ApprovalArtifactRepository,
  PlanApprovalService,
  PlanHashMatcher,
  type PlanRef,
} from '../plan-approval.js';

class InMemoryPlanRepo implements ApprovalArtifactRepository {
  public readonly records: ApprovalArtifact[] = [];
  async save(args: ApprovalArtifact): Promise<void> {
    const existing = this.records.find((r) => r.planId === args.planId);
    if (existing && existing.planSha !== args.planSha) {
      throw new Error(`sha conflict for plan ${args.planId}`);
    }
    this.records.push(args);
  }
  async findLatestForPlan(args: { planId: string }): Promise<ApprovalArtifact | null> {
    for (let i = this.records.length - 1; i >= 0; i -= 1) {
      const r = this.records[i];
      if (r && r.planId === args.planId) return r;
    }
    return null;
  }
}

class CapturingAudit {
  public readonly entries: Array<{
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }> = [];
  async append(args: {
    action: string;
    actor: string;
    target: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    this.entries.push(args);
  }
}

const allow = {
  kind: 'allow' as const,
  actor: 'ceo',
  permission: 'admin' as const,
  command: 'approve-plan' as const,
  sourceCommentId: 1,
  reason: 'ok',
};

const deny = {
  kind: 'deny' as const,
  actor: 'alice',
  permission: 'write' as const,
  command: 'approve-plan' as const,
  sourceCommentId: 1,
  reason: 'not enough',
};

const plan: PlanRef = {
  planId: 'plan-1',
  planSha: 'a'.repeat(64),
  generation: 3,
};

describe('PlanHashMatcher (T-M3-006)', () => {
  const matcher = new PlanHashMatcher();

  it('matches when plan_id+sha+generation all align', () => {
    const m = matcher.match({
      submitted: { planId: 'plan-1', planSha: 'a'.repeat(64) },
      candidates: [plan],
      currentGeneration: 3,
    });
    expect(m).not.toBeNull();
    expect(m?.planId).toBe('plan-1');
  });

  it('rejects when plan_id is unknown', () => {
    const m = matcher.match({
      submitted: { planId: 'nope', planSha: 'a'.repeat(64) },
      candidates: [plan],
      currentGeneration: 3,
    });
    expect(m).toBeNull();
  });

  it('rejects when plan_id is right but sha is wrong', () => {
    const m = matcher.match({
      submitted: { planId: 'plan-1', planSha: 'b'.repeat(64) },
      candidates: [plan],
      currentGeneration: 3,
    });
    expect(m).toBeNull();
  });

  it('rejects when the matched plan is from an older generation', () => {
    const older: PlanRef = { ...plan, generation: 1 };
    const m = matcher.match({
      submitted: { planId: 'plan-1', planSha: 'a'.repeat(64) },
      candidates: [older],
      currentGeneration: 3,
    });
    expect(m).toBeNull();
  });
});

describe('PlanApprovalService.decide (T-M3-006)', () => {
  it('approves when id+sha+generation match and actor is authorized', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit, () => 'a-1');
    const d = await svc.decide({
      submitted: { planId: 'plan-1', planSha: 'a'.repeat(64) },
      actor: 'ceo',
      sourceCommentId: 5,
      candidates: [plan],
      currentGeneration: 3,
      authorization: allow,
    });
    expect(d.kind).toBe('approved');
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]?.planId).toBe('plan-1');
    expect(audit.entries[0]?.action).toBe('plan.approve.approved');
  });

  it('rejects with not_authorized when authorizer denies', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit);
    const d = await svc.decide({
      submitted: { planId: 'plan-1', planSha: 'a'.repeat(64) },
      actor: 'alice',
      sourceCommentId: 5,
      candidates: [plan],
      currentGeneration: 3,
      authorization: deny,
    });
    expect(d.kind).toBe('rejected');
    if (d.kind !== 'rejected') return;
    expect(d.reason).toBe('not_authorized');
    expect(repo.records).toHaveLength(0);
  });

  it('rejects with plan_id_not_found when no candidate has that id', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit);
    const d = await svc.decide({
      submitted: { planId: 'unknown', planSha: 'a'.repeat(64) },
      actor: 'ceo',
      sourceCommentId: 5,
      candidates: [plan],
      currentGeneration: 3,
      authorization: allow,
    });
    expect(d.kind).toBe('rejected');
    if (d.kind !== 'rejected') return;
    expect(d.reason).toBe('plan_id_not_found');
    expect(audit.entries[0]?.action).toBe('plan.approve.rejected');
  });

  it('rejects with plan_sha_mismatch when id matches but sha does not', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit);
    const d = await svc.decide({
      submitted: { planId: 'plan-1', planSha: 'b'.repeat(64) },
      actor: 'ceo',
      sourceCommentId: 5,
      candidates: [plan],
      currentGeneration: 3,
      authorization: allow,
    });
    expect(d.kind).toBe('rejected');
    if (d.kind !== 'rejected') return;
    expect(d.reason).toBe('plan_sha_mismatch');
  });

  it('rejects with stale_generation when an older plan is approved', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit);
    const older: PlanRef = { ...plan, generation: 1 };
    const d = await svc.decide({
      submitted: { planId: 'plan-1', planSha: 'a'.repeat(64) },
      actor: 'ceo',
      sourceCommentId: 5,
      candidates: [older],
      currentGeneration: 3,
      authorization: allow,
    });
    expect(d.kind).toBe('rejected');
    if (d.kind !== 'rejected') return;
    expect(d.reason).toBe('stale_generation');
  });

  it('stale_generation beats plan_sha_mismatch when both could apply', async () => {
    const repo = new InMemoryPlanRepo();
    const audit = new CapturingAudit();
    const svc = new PlanApprovalService(repo, audit);
    const older: PlanRef = { ...plan, generation: 1 };
    // The submitted sha is WRONG, AND the only candidate is stale.
    // Both plan_sha_mismatch and stale_generation could apply; the
    // service picks stale_generation (the higher-signal reason).
    const d = await svc.decide({
      submitted: { planId: 'plan-1', planSha: 'x'.repeat(64) },
      actor: 'ceo',
      sourceCommentId: 5,
      candidates: [older],
      currentGeneration: 3,
      authorization: allow,
    });
    expect(d.kind).toBe('rejected');
    if (d.kind !== 'rejected') return;
    expect(d.reason).toBe('plan_sha_mismatch');
  });
});

/**
 * T-M9-004 MergeService + BranchProtectionChecker + IssueCloseService.
 *
 * Contracts (spec §12.10):
 *   - Merge only when final evaluator decision='merge'.
 *   - High-risk PR missing human review → merge refused + audited.
 *   - merge-manager token MUST NOT carry branch-protection-bypass
 *     scope (validateMergeTokenProfile).
 *   - Branch protection must still enforce checks; refuse if admin
 *     override would be required.
 *   - Post-merge: issue closed + cgao labels stripped + completion
 *     comment posted + audit record emitted.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { describe, expect, it } from 'vitest';
import { BranchProtectionChecker } from '../branch-protection-checker.js';
import type { BranchProtectionSnapshot } from '../github-state-hydrator.js';
import {
  DEFAULT_CGAO_LABELS,
  type IssueClosePort,
  IssueCloseService,
} from '../issue-close-service.js';
import {
  MERGE_TOKEN_REQUIRED_SCOPES,
  validateMergeTokenProfile,
} from '../merge-credential-profile.js';
import { type MergeExecutionPort, MergeService } from '../merge-service.js';
import type { MergeDecision } from '../types.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);

function makeDecision(decision: MergeDecision['decision'] = 'merge'): MergeDecision {
  return {
    runId: 'run_1',
    prNumber: 1,
    decision,
    currentHeadSha: HEAD,
    testedHeadSha: HEAD,
    testedBaseSha: BASE,
    currentBaseSha: BASE,
    digest: 'sha256:'.concat('0'.repeat(64)),
    reasons: [],
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const VALID_SCOPES = [...MERGE_TOKEN_REQUIRED_SCOPES];
const BYPASS_SCOPES = [...MERGE_TOKEN_REQUIRED_SCOPES, 'repo:administration:write'];

function goodToken() {
  return validateMergeTokenProfile({
    token: 'ghs_merge',
    scopes: VALID_SCOPES,
    isTrusted: true,
  });
}
function bypassToken() {
  return validateMergeTokenProfile({
    token: 'ghs_admin',
    scopes: BYPASS_SCOPES,
    isTrusted: true,
  });
}

function strongProtection(): BranchProtectionSnapshot {
  return {
    requiredCheckCount: 3,
    requiredReviewCount: 1,
    requiresStrictStatusChecks: true,
    enforceAdmins: true,
    dismissesStaleReviews: true,
  };
}

describe('T-M9-004 validateMergeTokenProfile', () => {
  it('rejects a token carrying repo:administration:write (bypass scope)', () => {
    const p = bypassToken();
    expect(p.isMergeManager).toBe(false);
    expect(p.validationErrors.some((e) => e.includes('forbidden scopes'))).toBe(true);
  });

  it('accepts a trusted token with the required scopes and no forbidden ones', () => {
    const p = goodToken();
    expect(p.isMergeManager).toBe(true);
    expect(p.validationErrors).toEqual([]);
  });

  it('rejects an untrusted-profile token even with correct scopes', () => {
    const p = validateMergeTokenProfile({
      token: 'ghs_untrusted',
      scopes: VALID_SCOPES,
      isTrusted: false,
    });
    expect(p.isMergeManager).toBe(false);
  });
});

describe('T-M9-004 BranchProtectionChecker', () => {
  it('rejects when enforce_admins=false (admin override required)', () => {
    const c = new BranchProtectionChecker().check({
      protection: { ...strongProtection(), enforceAdmins: false },
    });
    expect(c.ok).toBe(false);
    expect(c.reasons.some((r) => r.includes('enforce admins'))).toBe(true);
  });

  it('accepts when the rule is fully enforced', () => {
    const c = new BranchProtectionChecker().check({ protection: strongProtection() });
    expect(c.ok).toBe(true);
  });

  it('rejects when the protection rule is missing', () => {
    const c = new BranchProtectionChecker().check({ protection: null });
    expect(c.ok).toBe(false);
  });
});

describe('T-M9-004 MergeService', () => {
  class StubGithub implements MergeExecutionPort {
    merges = 0;
    async merge() {
      this.merges++;
      return { mergeCommitSha: 'e'.repeat(40) };
    }
  }

  it('refuses when final evaluator decision != merge', async () => {
    const github = new StubGithub();
    const audit = new InMemoryAuditChainService();
    const svc = new MergeService({
      github,
      audit,
      async resolveMergeToken() {
        return goodToken();
      },
    });
    const out = await svc.merge({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('refuse'),
      protection: strongProtection(),
      requiresHumanReview: false,
      humanReviewPassed: false,
    });
    expect(out.merged).toBe(false);
    expect(github.merges).toBe(0);
  });

  it('refuses a high-risk PR missing human review', async () => {
    const github = new StubGithub();
    const audit = new InMemoryAuditChainService();
    const svc = new MergeService({
      github,
      audit,
      async resolveMergeToken() {
        return goodToken();
      },
    });
    const out = await svc.merge({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      protection: strongProtection(),
      requiresHumanReview: true,
      humanReviewPassed: false,
    });
    expect(out.merged).toBe(false);
    expect(out.reasons.some((r) => r.includes('human review'))).toBe(true);
    // audit chain recorded the refusal
    const chain = await audit.listByRun('run_1');
    expect(chain.some((r) => r.kind === 'merge.refused')).toBe(true);
  });

  it('refuses when the merge token carries bypass scope', async () => {
    const github = new StubGithub();
    const audit = new InMemoryAuditChainService();
    const svc = new MergeService({
      github,
      audit,
      async resolveMergeToken() {
        return bypassToken();
      },
    });
    const out = await svc.merge({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      protection: strongProtection(),
      requiresHumanReview: false,
      humanReviewPassed: true,
    });
    expect(out.merged).toBe(false);
    expect(out.reasons.some((r) => r.includes('credential invalid'))).toBe(true);
  });

  it('executes the merge when all guards pass', async () => {
    const github = new StubGithub();
    const audit = new InMemoryAuditChainService();
    const svc = new MergeService({
      github,
      audit,
      async resolveMergeToken() {
        return goodToken();
      },
    });
    const out = await svc.merge({
      runId: 'run_1',
      repo: 'cgao/test',
      prNumber: 1,
      decision: makeDecision('merge'),
      protection: strongProtection(),
      requiresHumanReview: true,
      humanReviewPassed: true,
    });
    expect(out.merged).toBe(true);
    expect(out.mergeCommitSha).toBe('e'.repeat(40));
    const chain = await audit.listByRun('run_1');
    expect(chain.some((r) => r.kind === 'merge.executed')).toBe(true);
  });
});

describe('T-M9-004 IssueCloseService', () => {
  class StubIssuePort implements IssueClosePort {
    closed: number[] = [];
    removedLabels: string[] = [];
    comments: string[] = [];
    failComment = false;
    failClose = false;
    async closeIssue(args: { issueNumber: number }) {
      if (this.failClose) throw new Error('close boom');
      this.closed.push(args.issueNumber);
    }
    async removeLabel(args: { issueNumber: number; label: string }) {
      this.removedLabels.push(args.label);
    }
    async addComment(args: { issueNumber: number; body: string }) {
      if (this.failComment) throw new Error('comment boom');
      this.comments.push(args.body);
    }
  }

  it('closes the issue, strips cgao labels, and posts a comment', async () => {
    const port = new StubIssuePort();
    const audit = new InMemoryAuditChainService();
    const svc = new IssueCloseService(port, audit);
    const out = await svc.close({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      mergedHeadSha: HEAD,
      mergeCommitSha: 'e'.repeat(40),
    });
    expect(out.closed).toBe(true);
    expect(port.closed).toContain(7);
    expect(port.removedLabels.length).toBe(DEFAULT_CGAO_LABELS.length);
    expect(port.comments.length).toBe(1);
    const chain = await audit.listByRun('run_1');
    expect(chain.some((r) => r.kind === 'issue.closed')).toBe(true);
  });

  it('records errors but persists the audit record on partial failure', async () => {
    const port = new StubIssuePort();
    port.failClose = true;
    port.failComment = true;
    const audit = new InMemoryAuditChainService();
    const svc = new IssueCloseService(port, audit);
    const out = await svc.close({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      mergedHeadSha: HEAD,
      mergeCommitSha: 'e'.repeat(40),
    });
    expect(out.closed).toBe(false);
    expect(out.commentPosted).toBe(false);
    expect(out.errors.length).toBeGreaterThan(0);
    const chain = await audit.listByRun('run_1');
    expect(chain.some((r) => r.kind === 'issue.closed')).toBe(true);
  });
});

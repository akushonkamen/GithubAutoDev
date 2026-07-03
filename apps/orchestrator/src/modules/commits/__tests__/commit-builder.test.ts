/**
 * CommitBuilder — T-M7-002, spec §12.8 / §12.11.
 *
 * Locks the contracts:
 *   - happy path: applies a clean patch, writes a commit with a
 *     trailer block, returns the commit sha.
 *   - protected-file touch: aborts the commit and audits
 *     PROTECTED_FILE_VIOLATION (no commit lands).
 *   - dirty / disallowed path: the clean-checkout applier rejects,
 *     CommitBuilder surfaces that as an abort.
 *   - commit message carries issue, run_id, spec_id, plan_id@plan_sha.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { ProtectedFileDetector } from '@cgao/runner-broker';
import { describe, expect, it } from 'vitest';
import {
  type BuildCommitInput,
  CommitBuilder,
  type GitCommitPort,
  InMemoryGitCommitPort,
  PROTECTED_FILE_VIOLATION,
  type WorkerResultPatch,
} from '../commit-builder.js';

const planSha = 'a'.repeat(64);

function baseEmptyPatch(overrides: Partial<WorkerResultPatch> = {}): WorkerResultPatch {
  return {
    baseSha: 'b'.repeat(64),
    entries: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    ...overrides,
  };
}

function baseMessageInput(overrides: Record<string, unknown> = {}): BuildCommitInput['message'] {
  return {
    summary: 'fix deploy script',
    issueNumber: 42,
    runId: 'run_abc',
    specId: 'spec-0001',
    planId: 'plan-0001',
    planSha,
    ...overrides,
  } as BuildCommitInput['message'];
}

describe('CommitBuilder (T-M7-002, spec §12.8 / §12.11)', () => {
  it('commits a clean patch and returns a sha', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    const cb = new CommitBuilder({ git, audit });

    const result = await cb.build({
      runId: 'run_abc',
      branchName: 'cgao/issue-42-fix-deploy',
      patch: baseEmptyPatch({
        entries: [{ path: 'src/deploy.ts', contents: 'export const x = 1;', deleted: false }],
      }),
      message: baseMessageInput(),
      base: new Map(),
    });

    expect(result.decision).toBe('committed');
    expect(result.commitSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.changedFiles).toContain('src/deploy.ts');
  });

  it('audit-logs commit.create after a successful commit', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    const cb = new CommitBuilder({ git, audit });

    await cb.build({
      runId: 'run_audit',
      branchName: 'cgao/issue-42-fix',
      patch: baseEmptyPatch({
        entries: [{ path: 'src/a.ts', contents: 'a', deleted: false }],
      }),
      message: baseMessageInput({ runId: 'run_audit' }),
      base: new Map(),
    });

    const events = await audit.listByRun('run_audit');
    expect(events.some((e) => e.kind === 'commit.create')).toBe(true);
  });

  it('aborts and audits PROTECTED_FILE_VIOLATION when a protected path is touched', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    const cb = new CommitBuilder({ git, audit });

    const result = await cb.build({
      runId: 'run_pv',
      branchName: 'cgao/issue-42-bad',
      // Allow-list the protected path so the applier doesn't reject;
      // the post-apply sweep is what catches it.
      patch: baseEmptyPatch({
        allowedPaths: ['.github/**', 'src/**'],
        entries: [
          { path: '.github/workflows/ci.yml', contents: 'evil', deleted: false },
        ],
      }),
      message: baseMessageInput({ runId: 'run_pv' }),
      base: new Map(),
    });

    expect(result.decision).toBe('aborted');
    expect(result.commitSha).toBeUndefined();
    expect(result.reasons.some((r) => r.includes('protected file touched'))).toBe(true);

    const events = await audit.listByRun('run_pv');
    const pv = events.find((e) => e.kind === PROTECTED_FILE_VIOLATION);
    expect(pv).toBeDefined();
    expect(pv?.payload.protectedTouched).toContain('.github/workflows/ci.yml');
    // No commit.create event should land.
    expect(events.some((e) => e.kind === 'commit.create')).toBe(false);
  });

  it('aborts when the applier rejects a path outside allowedPaths', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    const cb = new CommitBuilder({ git, audit });

    const result = await cb.build({
      runId: 'run_oop',
      branchName: 'cgao/issue-42-bad',
      patch: baseEmptyPatch({
        allowedPaths: ['src/**'],
        entries: [{ path: 'docs/outside.md', contents: 'x', deleted: false }],
      }),
      message: baseMessageInput({ runId: 'run_oop' }),
      base: new Map(),
    });

    expect(result.decision).toBe('aborted');
    expect(result.reasons.some((r) => r.includes('not in allowedPaths'))).toBe(true);
  });

  it('the commit message embeds issue, run_id, spec_id, plan_id@plan_sha', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    const captured: string[] = [];
    const spyGit: GitCommitPort = {
      async readTree() {
        return new Map();
      },
      async writeCommit(args) {
        captured.push(args.commitMessage);
        return { commitSha: 'sha256:deadbeef', changedFiles: [] };
      },
    };
    const cb = new CommitBuilder({ git: spyGit, audit });

    await cb.build({
      runId: 'run_msg',
      branchName: 'cgao/issue-7-x',
      patch: baseEmptyPatch({
        entries: [{ path: 'src/a.ts', contents: 'a', deleted: false }],
      }),
      message: baseMessageInput({
        runId: 'run_msg',
        issueNumber: 7,
        specId: 'spec-99',
        planId: 'plan-42',
        planSha,
        summary: 'fix the thing',
      }),
      base: new Map(),
    });

    expect(captured.length).toBe(1);
    const msg = captured[0];
    expect(msg).toContain('issue #7');
    expect(msg).toContain('run-id run_msg');
    expect(msg).toContain('Spec-Id: spec-99');
    expect(msg).toContain('Plan-Id: plan-42@' + planSha);
  });

  it('honors an injected ProtectedFileDetector', async () => {
    const git = new InMemoryGitCommitPort();
    const audit = new InMemoryAuditChainService();
    // Custom detector that treats `intel/secret.txt` as protected.
    const detector = new ProtectedFileDetector(['intel/secret.txt']);
    const cb = new CommitBuilder({ git, audit, protectedFileDetector: detector });

    const result = await cb.build({
      runId: 'run_inj',
      branchName: 'cgao/issue-1-x',
      patch: baseEmptyPatch({
        allowedPaths: ['intel/**', 'src/**'],
        entries: [{ path: 'intel/secret.txt', contents: 'x', deleted: false }],
      }),
      message: baseMessageInput({ runId: 'run_inj' }),
      base: new Map(),
    });

    expect(result.decision).toBe('aborted');
  });
});

/**
 * BranchService + naming policy — T-M7-001, spec §12.8 / §15.
 *
 * Locks the contracts:
 *   - branch name format is `cgao/issue-<n>-<slug>` with a normalized slug.
 *   - idempotent: same (runId, issue, slug) → same branch ref, no duplicate.
 *   - slug normalization: `Fix Deploy Bug!` → `fix-deploy-bug`.
 *   - refused slugs: `..`, lockfile-style, secret-pattern basenames.
 *   - audit event records before/after SHA on every create.
 */

import { InMemoryAuditChainService } from '@cgao/audit';
import { describe, expect, it } from 'vitest';
import { BranchService, InMemoryGitPort } from '../branch-service.js';
import {
  BranchNamingError,
  formatBranchName,
  normalizeSlug,
  validateSlug,
} from '../naming-policy.js';

describe('normalizeSlug (T-M7-001)', () => {
  it('lowercases and dasherizes', () => {
    expect(normalizeSlug('Fix Deploy Bug!')).toBe('fix-deploy-bug');
    expect(normalizeSlug('  Mixed   CASE ')).toBe('mixed-case');
  });

  it('drops non-ascii letter diacritics and replaces separators', () => {
    // NFKD splits accented chars into base + combining mark; the combining
    // mark is not [a-z0-9] so it becomes a dash (collapsed later).
    expect(normalizeSlug('café-résumé')).toBe('cafe-re-sume');
  });

  it('collapses consecutive separators', () => {
    expect(normalizeSlug('a..b//c')).toBe('a-b-c');
  });

  it('strips leading and trailing dashes', () => {
    expect(normalizeSlug('--foo--')).toBe('foo');
  });

  it('truncates to 40 chars on a dash boundary', () => {
    const long = 'a'.repeat(80);
    const out = normalizeSlug(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });
});

describe('validateSlug (T-M7-001)', () => {
  it('rejects empty slug', () => {
    expect(() => validateSlug('')).toThrow(BranchNamingError);
  });

  it('rejects slugs containing `..`', () => {
    expect(() => validateSlug('a..b')).toThrow(BranchNamingError);
  });

  it('rejects lockfile-style basenames', () => {
    expect(() => validateSlug('pnpm-lock.yaml')).toThrow(BranchNamingError);
    expect(() => validateSlug('package.json')).toThrow(BranchNamingError);
    expect(() => validateSlug('yarn.lock')).toThrow(BranchNamingError);
  });

  it('rejects secret-pattern basenames', () => {
    expect(() => validateSlug('.env')).toThrow(BranchNamingError);
    expect(() => validateSlug('.npmrc')).toThrow(BranchNamingError);
  });

  it('accepts a plain alphanumeric slug', () => {
    expect(() => validateSlug('fix-deploy-bug')).not.toThrow();
  });
});

describe('formatBranchName (T-M7-001)', () => {
  it('formats cgao/issue-<n>-<slug>', () => {
    expect(formatBranchName({ issueNumber: 42, slug: 'Fix Deploy Bug!' })).toEqual({
      slug: 'fix-deploy-bug',
      branchName: 'cgao/issue-42-fix-deploy-bug',
    });
  });

  it('rejects non-positive issue numbers', () => {
    expect(() => formatBranchName({ issueNumber: 0, slug: 'x' })).toThrow(BranchNamingError);
    expect(() => formatBranchName({ issueNumber: -1, slug: 'x' })).toThrow(BranchNamingError);
  });
});

describe('BranchService (T-M7-001)', () => {
  it('creates a branch and returns the base sha', async () => {
    const git = new InMemoryGitPort();
    const audit = new InMemoryAuditChainService();
    const svc = new BranchService({ git, audit });

    const r = await svc.create({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      slug: 'Fix Deploy Bug!',
    });

    expect(r.branchName).toBe('cgao/issue-7-fix-deploy-bug');
    expect(r.slug).toBe('fix-deploy-bug');
    expect(r.baseSha).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(r.created).toBe(true);
    expect(git.has(r.branchName)).toBe(true);
  });

  it('is idempotent: second create returns the same branch ref', async () => {
    const git = new InMemoryGitPort();
    const audit = new InMemoryAuditChainService();
    const svc = new BranchService({ git, audit });

    const a = await svc.create({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      slug: 'Fix Deploy Bug!',
    });
    const b = await svc.create({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 7,
      slug: 'fix-deploy-bug',
    });

    expect(a.branchName).toBe(b.branchName);
    expect(b.created).toBe(false);
  });

  it('records an audit event with before/after sha on create', async () => {
    const git = new InMemoryGitPort();
    const audit = new InMemoryAuditChainService();
    const svc = new BranchService({ git, audit });

    await svc.create({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: 9,
      slug: 'feature-x',
    });

    const events = await audit.listByRun('run_1');
    expect(events.length).toBe(1);
    const ev = events[0];
    expect(ev?.kind).toBe('branch.create');
    expect(ev?.payload).toMatchObject({
      repo: 'cgao/test',
      issueNumber: 9,
      branchName: 'cgao/issue-9-feature-x',
      created: true,
    });
    // baseSha present (before/after sha record).
    expect(typeof ev?.payload.baseSha).toBe('string');
  });

  it('extends the audit hash chain without breaking it', async () => {
    const git = new InMemoryGitPort();
    const audit = new InMemoryAuditChainService();
    const svc = new BranchService({ git, audit });

    await svc.create({
      runId: 'run_chain',
      repo: 'cgao/test',
      issueNumber: 1,
      slug: 'a',
    });
    await svc.create({
      runId: 'run_chain',
      repo: 'cgao/test',
      issueNumber: 2,
      slug: 'b',
    });

    expect(await audit.verifyRun('run_chain')).toBeNull();
  });

  it('refuses a sensitive slug', async () => {
    const git = new InMemoryGitPort();
    const audit = new InMemoryAuditChainService();
    const svc = new BranchService({ git, audit });

    await expect(
      svc.create({
        runId: 'run_1',
        repo: 'cgao/test',
        issueNumber: 1,
        slug: 'pnpm-lock.yaml',
      }),
    ).rejects.toThrow(BranchNamingError);
  });
});

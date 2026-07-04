/**
 * GithubOctokitAdapter — endpoint mapping tests.
 *
 * Each port method is exercised against a mocked Octokit REST surface.
 * The mock records the endpoint name + arguments so the test can assert
 * that the adapter hits the correct REST method with the correct args.
 *
 * No network. No real GitHub. The adapter is pure transport — once we
 * trust the mapping, the live behavior is GitHub's responsibility.
 */

import { describe, expect, it } from 'vitest';
import { GithubOctokitAdapter, type OpenPr } from '../adapters/github-pr-port.js';

interface RecordedCall {
  endpoint: string;
  args: Record<string, unknown>;
}

function makeMockOctokit() {
  const calls: RecordedCall[] = [];
  const pulls = {
    list: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'pulls.list', args });
      return {
        data: [
          {
            number: 7,
            html_url: 'https://github.com/o/r/pull/7',
            head: { sha: 'headsha7' },
            body: '<!-- cgao:status-comment-marker run-xyz -->',
          },
          {
            number: 9,
            html_url: 'https://github.com/o/r/pull/9',
            head: { sha: 'headsha9' },
            body: 'no marker here',
          },
        ],
      };
    },
    create: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'pulls.create', args });
      return { data: { number: 42, html_url: 'https://github.com/o/r/pull/42' } };
    },
    get: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'pulls.get', args });
      return {
        data: {
          number: 42,
          head: { sha: 'heads', repo: { permissions: { push: true } } },
          base: { sha: 'basesha', ref: 'main' },
          mergeable_state: 'clean',
          state: 'open',
          merged: false,
        },
      };
    },
    merge: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'pulls.merge', args });
      return { data: { sha: 'mergecommitsha' } };
    },
  };
  const issues = {
    update: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'issues.update', args });
      return { data: {} };
    },
    removeLabel: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'issues.removeLabel', args });
      return { data: {} };
    },
    createComment: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'issues.createComment', args });
      return { data: {} };
    },
  };
  const repos = {
    getBranchProtection: async (args: Record<string, unknown>) => {
      calls.push({ endpoint: 'repos.getBranchProtection', args });
      return {
        data: {
          required_status_checks: { strict: true, contexts: ['ci-a', 'ci-b', 'ci-c'] },
          required_pull_request_reviews: {
            required_approving_review_count: 2,
            dismiss_stale_reviews: true,
          },
          enforce_admins: { enabled: true },
        },
      };
    },
  };
  const paginate = {
    iterator<T>(_fn: unknown, opts: Record<string, unknown>): AsyncIterable<{ data: T[] }> {
      return (async function* gen() {
        const res = await pulls.list(opts);
        // biome-ignore lint/suspicious/noExplicitAny: test mock shape
        yield { data: res.data as any[] };
      })();
    },
  };
  const octokit = {
    rest: { pulls, issues, repos },
    paginate,
  };
  return { octokit, calls };
}

describe('GithubOctokitAdapter', () => {
  it('listOpenPrsForRun filters by marker and returns matching PRs', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    const out: readonly OpenPr[] = await adapter.listOpenPrsForRun({
      repo: 'o/r',
      runId: 'run-xyz',
    });
    expect(out.length).toBe(1);
    expect(out[0]?.prNumber).toBe(7);
    expect(out[0]?.headSha).toBe('headsha7');
    expect(calls[0]?.endpoint).toBe('pulls.list');
    expect(calls[0]?.args).toMatchObject({ owner: 'o', repo: 'r', state: 'open' });
  });

  it('createPr maps to pulls.create with owner/repo/head/base', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    const res = await adapter.createPr({
      repo: 'o/r',
      branchName: 'cgao/feat-1',
      baseBranch: 'main',
      title: 'T-1',
      body: 'hello',
    });
    expect(res).toEqual({ prNumber: 42, prUrl: 'https://github.com/o/r/pull/42' });
    expect(calls[0]?.endpoint).toBe('pulls.create');
    expect(calls[0]?.args).toMatchObject({
      owner: 'o',
      repo: 'r',
      head: 'cgao/feat-1',
      base: 'main',
      title: 'T-1',
      body: 'hello',
    });
  });

  it('fetchPr maps to pulls.get and projects to LivePrSnapshot', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    const snap = await adapter.fetchPr({ repo: 'o/r', prNumber: 42 });
    expect(snap).not.toBeNull();
    expect(snap?.prNumber).toBe(42);
    expect(snap?.headSha).toBe('heads');
    expect(snap?.baseSha).toBe('basesha');
    expect(snap?.baseBranch).toBe('main');
    expect(snap?.mergeableState).toBe('clean');
    expect(snap?.state).toBe('open');
    expect(snap?.protected).toBe(true);
    expect(calls[0]?.endpoint).toBe('pulls.get');
    expect(calls[0]?.args).toMatchObject({ owner: 'o', repo: 'r', pull_number: 42 });
  });

  it('fetchBranchProtection maps to repos.getBranchProtection and projects snapshot', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    const prot = await adapter.fetchBranchProtection({ repo: 'o/r', baseBranch: 'main' });
    expect(prot).toEqual({
      requiredCheckCount: 3,
      requiredReviewCount: 2,
      requiresStrictStatusChecks: true,
      enforceAdmins: true,
      dismissesStaleReviews: true,
    });
    expect(calls[0]?.endpoint).toBe('repos.getBranchProtection');
    expect(calls[0]?.args).toMatchObject({ owner: 'o', repo: 'r', branch: 'main' });
  });

  it('closeIssue maps to issues.update with state=closed', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    await adapter.closeIssue({ repo: 'o/r', issueNumber: 7 });
    expect(calls[0]?.endpoint).toBe('issues.update');
    expect(calls[0]?.args).toMatchObject({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      state: 'closed',
    });
  });

  it('removeLabel maps to issues.removeLabel; 404 is swallowed', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    await adapter.removeLabel({ repo: 'o/r', issueNumber: 7, label: 'cgao:new' });
    expect(calls[0]?.endpoint).toBe('issues.removeLabel');
    expect(calls[0]?.args).toMatchObject({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      name: 'cgao:new',
    });
  });

  it('addComment maps to issues.createComment', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    await adapter.addComment({ repo: 'o/r', issueNumber: 7, body: 'hi' });
    expect(calls[0]?.endpoint).toBe('issues.createComment');
    expect(calls[0]?.args).toMatchObject({
      owner: 'o',
      repo: 'r',
      issue_number: 7,
      body: 'hi',
    });
  });

  it('merge maps to pulls.merge with default squash method', async () => {
    const { octokit, calls } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    const res = await adapter.merge({ repo: 'o/r', prNumber: 42 });
    expect(res.mergeCommitSha).toBe('mergecommitsha');
    expect(calls[0]?.endpoint).toBe('pulls.merge');
    expect(calls[0]?.args).toMatchObject({
      owner: 'o',
      repo: 'r',
      pull_number: 42,
      merge_method: 'squash',
    });
  });

  it('rejects malformed repo identifiers', async () => {
    const { octokit } = makeMockOctokit();
    const adapter = new GithubOctokitAdapter({ octokit: octokit as never });
    await expect(
      adapter.createPr({
        repo: 'not-a-repo',
        branchName: 'b',
        baseBranch: 'main',
        title: 't',
        body: 'x',
      }),
    ).rejects.toThrow(/malformed repo identifier/);
  });
});

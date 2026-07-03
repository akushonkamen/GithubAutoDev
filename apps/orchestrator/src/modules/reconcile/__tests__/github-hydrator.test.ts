/**
 * T-M10-001 GitHubHydrator.
 */

import { describe, expect, it } from 'vitest';
import { GitHubHydrator, type TrustedGithubHydrationPort } from '../github-hydrator.js';

class Stub implements TrustedGithubHydrationPort {
  async fetchIssue() {
    return null;
  }
  async fetchPr() {
    return null;
  }
}

describe('T-M10-001 GitHubHydrator', () => {
  it('returns a DriftReport with null snapshots when none fetched', async () => {
    const h = new GitHubHydrator(new Stub());
    const report = await h.hydrate({
      runId: 'run_1',
      repo: 'cgao/test',
      issueNumber: null,
      prNumber: null,
    });
    expect(report.runId).toBe('run_1');
    expect(report.live.issue).toBeNull();
    expect(report.live.pr).toBeNull();
    expect(report.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });

  it('hydrates issue and pr when numbers are provided', async () => {
    const github: TrustedGithubHydrationPort = {
      async fetchIssue({ repo, issueNumber }) {
        return {
          repo,
          issueNumber,
          labels: ['cgao:plan-ready'],
          hasStatusComment: true,
          state: 'open' as const,
        };
      },
      async fetchPr({ repo, prNumber }) {
        return {
          repo,
          prNumber,
          headSha: 'a'.repeat(40),
          baseSha: 'b'.repeat(40),
          state: 'open' as const,
          checks: [],
          reviews: [],
        };
      },
    };
    const h = new GitHubHydrator(github);
    const report = await h.hydrate({
      runId: 'run_3',
      repo: 'cgao/test',
      issueNumber: 9,
      prNumber: 11,
    });
    expect(report.live.issue?.labels).toEqual(['cgao:plan-ready']);
    expect(report.live.pr?.headSha).toBe('a'.repeat(40));
  });
});

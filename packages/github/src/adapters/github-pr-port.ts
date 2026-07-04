/**
 * Octokit-backed GitHub adapter — Plan B Phase 1.
 *
 * Implements every GitHub-side port the production orchestrator imports:
 *
 *   - GitHubPrPort               (list/create PRs — spec §12.8)
 *   - TrustedGitHubPrPort        (live PR snapshot + protection — §12.10)
 *   - IssueClosePort             (close/label/comment — §12.10)
 *   - MergeExecutionPort         (merge a PR — §12.10)
 *
 * The port shapes are re-declared here (not imported from the orchestrator
 * package, which would create a build-time cycle); the e2e suite's
 * FakeGitHubClient mirrors the exact same surface, so the orchestrator
 * accepts this adapter wherever it accepts the fake.
 *
 * Each method maps directly to the corresponding Octokit REST endpoint.
 * No business logic lives here — this is the trusted transport layer.
 */

import type { Octokit } from '@octokit/rest';

/** Repository identifier in `owner/name` form. */
export type RepoRef = string;

export interface OpenPr {
  prNumber: number;
  prUrl: string;
  /** Head sha the PR currently points at. */
  headSha: string;
}

/** ---- PullRequestService.GitHubPrPort ---- */
export interface GitHubPrPort {
  listOpenPrsForRun(args: { repo: RepoRef; runId: string }): Promise<readonly OpenPr[]>;
  createPr(args: {
    repo: RepoRef;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string }>;
}

export interface LivePrSnapshot {
  prNumber: number;
  headSha: string;
  baseSha: string;
  baseBranch: string;
  mergeableState: 'clean' | 'blocked' | 'behind' | 'dirty' | 'unknown' | 'unstable';
  state: 'open' | 'closed' | 'merged';
  protected: boolean;
}

export interface BranchProtectionSnapshot {
  requiredCheckCount: number;
  requiredReviewCount: number;
  requiresStrictStatusChecks: boolean;
  enforceAdmins: boolean;
  dismissesStaleReviews: boolean;
}

/** ---- TrustedGitHubPrPort ---- */
export interface TrustedGitHubPrPort {
  fetchPr(args: { repo: RepoRef; prNumber: number }): Promise<LivePrSnapshot | null>;
  fetchBranchProtection(args: {
    repo: RepoRef;
    baseBranch: string;
  }): Promise<BranchProtectionSnapshot | null>;
}

/** ---- IssueClosePort ---- */
export interface IssueClosePort {
  closeIssue(args: { repo: RepoRef; issueNumber: number }): Promise<void>;
  removeLabel(args: { repo: RepoRef; issueNumber: number; label: string }): Promise<void>;
  addComment(args: { repo: RepoRef; issueNumber: number; body: string }): Promise<void>;
}

/** ---- MergeExecutionPort ---- */
export interface MergeExecutionPort {
  merge(args: {
    repo: RepoRef;
    prNumber: number;
    method?: 'merge' | 'squash' | 'rebase';
  }): Promise<{ mergeCommitSha: string }>;
}

export interface GithubAdapterOptions {
  /** Octokit instance to wrap (typically the installation-authenticated one). */
  octokit: Octokit;
  /** Markertext used by listOpenPrsForRun to find PRs for a given run. */
  markerPattern?: RegExp;
}

/** Standard marker line PRs render; listOpenPrsForRun greps for it. */
const DEFAULT_MARKER_PATTERN = /<!--\s*cgao:status-comment-marker\s+(\S+)\s*-->/u;

/**
 * Split "owner/name" into its components. Throws on malformed input —
 * the orchestrator MUST validate upstream, but defense in depth.
 */
function splitRepo(repo: RepoRef): { owner: string; repo: string } {
  const parts = repo.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`GithubAdapter: malformed repo identifier "${repo}" (expected "owner/name")`);
  }
  return { owner: parts[0], repo: parts[1] };
}

export class GithubOctokitAdapter
  implements GitHubPrPort, TrustedGitHubPrPort, IssueClosePort, MergeExecutionPort
{
  private readonly marker: RegExp;
  private readonly octokit: Octokit;

  constructor(opts: GithubAdapterOptions) {
    this.octokit = opts.octokit;
    this.marker = opts.markerPattern ?? DEFAULT_MARKER_PATTERN;
  }

  /** ---- GitHubPrPort ---- */

  async listOpenPrsForRun(args: { repo: RepoRef; runId: string }): Promise<readonly OpenPr[]> {
    const { owner, repo } = splitRepo(args.repo);
    // Iterate all open PRs; filter by the marker referencing runId.
    const out: OpenPr[] = [];
    const iter = this.octokit.paginate.iterator(this.octokit.rest.pulls.list, {
      owner,
      repo,
      state: 'open',
      per_page: 100,
    });
    for await (const page of iter) {
      for (const pr of page.data) {
        if (!pr.body) continue;
        const match = this.marker.exec(pr.body);
        if (!match) continue;
        if (match[1] !== args.runId) continue;
        out.push({
          prNumber: pr.number,
          prUrl: pr.html_url,
          headSha: pr.head?.sha ?? '',
        });
      }
    }
    return out;
  }

  async createPr(args: {
    repo: RepoRef;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string }> {
    const { owner, repo } = splitRepo(args.repo);
    const res = await this.octokit.rest.pulls.create({
      owner,
      repo,
      title: args.title,
      body: args.body,
      head: args.branchName,
      base: args.baseBranch,
    });
    return { prNumber: res.data.number, prUrl: res.data.html_url };
  }

  /** ---- TrustedGitHubPrPort ---- */

  async fetchPr(args: { repo: RepoRef; prNumber: number }): Promise<LivePrSnapshot | null> {
    const { owner, repo } = splitRepo(args.repo);
    try {
      const res = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: args.prNumber,
      });
      const pr = res.data;
      return {
        prNumber: pr.number,
        headSha: pr.head?.sha ?? '',
        baseSha: pr.base?.sha ?? '',
        baseBranch: pr.base?.ref ?? 'main',
        mergeableState: (pr.mergeable_state ?? 'unknown') as LivePrSnapshot['mergeableState'],
        state: pr.merged ? 'merged' : ((pr.state ?? 'open') as 'open' | 'closed'),
        protected: Boolean(pr.head?.repo?.permissions),
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw err;
    }
  }

  async fetchBranchProtection(args: {
    repo: RepoRef;
    baseBranch: string;
  }): Promise<BranchProtectionSnapshot | null> {
    const { owner, repo } = splitRepo(args.repo);
    try {
      const res = await this.octokit.rest.repos.getBranchProtection({
        owner,
        repo,
        branch: args.baseBranch,
      });
      const p = res.data;
      const checks = p.required_status_checks;
      const reviews = p.required_pull_request_reviews;
      return {
        requiredCheckCount: Array.isArray(checks?.contexts) ? (checks?.contexts.length ?? 0) : 0,
        requiredReviewCount: reviews?.required_approving_review_count ?? 0,
        requiresStrictStatusChecks: checks?.strict === true,
        enforceAdmins: p.enforce_admins?.enabled === true,
        dismissesStaleReviews: reviews?.dismiss_stale_reviews === true,
      };
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) return null;
      throw err;
    }
  }

  /** ---- IssueClosePort ---- */

  async closeIssue(args: { repo: RepoRef; issueNumber: number }): Promise<void> {
    const { owner, repo } = splitRepo(args.repo);
    await this.octokit.rest.issues.update({
      owner,
      repo,
      issue_number: args.issueNumber,
      state: 'closed',
    });
  }

  async removeLabel(args: { repo: RepoRef; issueNumber: number; label: string }): Promise<void> {
    const { owner, repo } = splitRepo(args.repo);
    try {
      await this.octokit.rest.issues.removeLabel({
        owner,
        repo,
        issue_number: args.issueNumber,
        name: args.label,
      });
    } catch (err) {
      // 404 = label absent; treat as no-op per IssueCloseService contract.
      const status = (err as { status?: number }).status;
      if (status === 404) return;
      throw err;
    }
  }

  async addComment(args: { repo: RepoRef; issueNumber: number; body: string }): Promise<void> {
    const { owner, repo } = splitRepo(args.repo);
    await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: args.issueNumber,
      body: args.body,
    });
  }

  /** ---- MergeExecutionPort ---- */

  async merge(args: {
    repo: RepoRef;
    prNumber: number;
    method?: 'merge' | 'squash' | 'rebase';
  }): Promise<{ mergeCommitSha: string }> {
    const { owner, repo } = splitRepo(args.repo);
    const res = await this.octokit.rest.pulls.merge({
      owner,
      repo,
      pull_number: args.prNumber,
      merge_method: args.method ?? 'squash',
    });
    return { mergeCommitSha: res.data.sha ?? '' };
  }
}

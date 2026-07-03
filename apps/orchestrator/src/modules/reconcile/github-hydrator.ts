/**
 * GitHubHydrator — T-M10-001, spec §12.2.
 *
 * For each in-flight workflow_run, fetches the current PR / issue / check /
 * review state from GitHub through the trusted client. The returned
 * `DriftReport` is consumed by DriftDetector, which compares it to the DB
 * projection and emits repair events on the bus.
 *
 * This module talks ONLY to the trusted GitHub client (spec §6.4, AS-01).
 * It performs no DB writes and no mutations — pure hydration.
 */

export interface LiveIssueSnapshot {
  repo: string;
  issueNumber: number;
  /** Current label set on the issue (canonical projection target). */
  labels: string[];
  /** True iff the cgao status comment is still present. */
  hasStatusComment: boolean;
  /** State: 'open' | 'closed'. */
  state: 'open' | 'closed';
}

export interface LivePrSnapshot {
  repo: string;
  prNumber: number;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed' | 'merged';
  /** Latest check run conclusions for the head sha (.Rollup). */
  checks: ReadonlyArray<{
    name: string;
    status: 'completed' | 'in_progress' | 'queued';
    conclusion: string | null;
  }>;
  /** Review decisions currently recorded on the PR. */
  reviews: ReadonlyArray<{ author: string; state: string }>;
}

export interface LiveRunSnapshot {
  runId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  issue: LiveIssueSnapshot | null;
  pr: LivePrSnapshot | null;
}

export interface DriftReport {
  runId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
  /** Snapshot fetched from GitHub (the "reality"). */
  live: LiveRunSnapshot;
  fetchedAt: string;
}

/** Trusted GitHub port for hydration. Production wires Octokit; tests wire a stub. */
export interface TrustedGithubHydrationPort {
  fetchIssue(args: { repo: string; issueNumber: number }): Promise<LiveIssueSnapshot | null>;
  fetchPr(args: { repo: string; prNumber: number }): Promise<LivePrSnapshot | null>;
}

export interface HydrateRunInput {
  runId: string;
  repo: string;
  issueNumber: number | null;
  prNumber: number | null;
}

export class GitHubHydrator {
  constructor(private readonly github: TrustedGithubHydrationPort) {}

  async hydrate(input: HydrateRunInput): Promise<DriftReport> {
    const issue =
      input.issueNumber !== null
        ? await this.github.fetchIssue({ repo: input.repo, issueNumber: input.issueNumber })
        : null;
    const pr =
      input.prNumber !== null
        ? await this.github.fetchPr({ repo: input.repo, prNumber: input.prNumber })
        : null;
    const live: LiveRunSnapshot = {
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      issue,
      pr,
    };
    return {
      runId: input.runId,
      repo: input.repo,
      issueNumber: input.issueNumber,
      prNumber: input.prNumber,
      live,
      fetchedAt: new Date().toISOString(),
    };
  }
}

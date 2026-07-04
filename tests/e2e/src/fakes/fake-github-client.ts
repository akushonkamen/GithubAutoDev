/**
 * FakeGitHubClient — single recording surface for all GitHub mutations
 * in the e2e suite.
 *
 * Implements every GitHub-side port the production modules import:
 *
 *   - PullRequestService.GitHubPrPort        (list/create PRs)
 *   - MergeService.MergeExecutionPort        (merge a PR)
 *   - IssueCloseService.IssueClosePort       (close issue / labels / comment)
 *   - GitHubStateHydrator.TrustedGitHubPrPort (live PR snapshot + protection)
 *
 * Plus the issue-create port the intake issuer hands to the Trusted
 * Control Runner (we test that flow by reading the published
 * `intake.issue.create_requested` event off the bus instead).
 *
 * Every mutation is recorded in `mutations` with its kind + arguments
 * so the test can assert ordering + content. GETs return canned
 * deterministic responses.
 *
 * This is a FAKE — there is no network. Production wires a real
 * Octokit-based client against the same port interfaces.
 */

import type {
  BranchProtectionSnapshot,
  LivePrSnapshot,
  TrustedGitHubPrPort,
} from '@cgao/orchestrator';
import type { IssueClosePort } from '@cgao/orchestrator';
import type { GitHubPrPort, OpenPr } from '@cgao/orchestrator';
import type { z } from 'zod';

/** Mutations are recorded with a stable kind + the args object. */
export interface RecordedMutation {
  kind:
    | 'pr.create'
    | 'pr.merge'
    | 'issue.close'
    | 'issue.label.remove'
    | 'issue.label.add'
    | 'issue.comment.add';
  args: Record<string, unknown>;
  /** Monotonic counter — mutations are appended in call order. */
  seq: number;
}

export interface MergePortInput {
  repo: string;
  prNumber: number;
  method?: 'merge' | 'squash' | 'rebase';
}

/**
 * Configuration: pre-seed the snapshots + the next PR number to hand
 * out. Tests construct one FakeGitHubClient per scenario and pass it
 * to every module that needs a GitHub port.
 */
export interface FakeGitHubConfig {
  /** Login the fake bot reports (used by IssueCloseService audit). */
  botLogin?: string;
  /** Default base sha for resolveBaseSha + hydrator. */
  baseBranch?: string;
  baseSha?: string;
  /** First PR number to hand out (default 1). */
  firstPrNumber?: number;
  /** Live PR state — defaults to a clean, open, protected PR. */
  defaultPrSnapshot?: Partial<LivePrSnapshot>;
  /** Branch protection snapshot — defaults to a strict rule. */
  defaultProtection?: Partial<BranchProtectionSnapshot>;
}

export class FakeGitHubClient
  implements GitHubPrPort, TrustedGitHubPrPort, IssueClosePort, MergeExecutionPortLike
{
  readonly mutations: RecordedMutation[] = [];
  private seq = 0;

  /** PRs we have "created", keyed by prNumber. */
  private readonly prs = new Map<number, FakePrRow>();
  /** Live snapshots keyed by prNumber. hydrator reads from here. */
  private readonly live = new Map<number, LivePrSnapshot>();
  /** Per-PR head sha override — set by the test to simulate drift. */
  private readonly headShaOverride = new Map<number, string>();
  private nextPrNumber: number;
  private readonly baseBranch: string;
  private readonly baseSha: string;
  private readonly defaultProtection: BranchProtectionSnapshot;

  constructor(private readonly config: FakeGitHubConfig = {}) {
    this.nextPrNumber = config.firstPrNumber ?? 1;
    this.baseBranch = config.baseBranch ?? 'main';
    this.baseSha = config.baseSha ?? '0'.repeat(40);
    this.defaultProtection = {
      requiredCheckCount: 3,
      requiredReviewCount: 1,
      requiresStrictStatusChecks: true,
      enforceAdmins: true,
      dismissesStaleReviews: true,
      ...config.defaultProtection,
    };
  }

  /** ---- PullRequestService.GitHubPrPort ---- */

  async listOpenPrsForRun(args: { repo: string; runId: string }): Promise<readonly OpenPr[]> {
    const out: OpenPr[] = [];
    for (const pr of this.prs.values()) {
      if (pr.runId !== args.runId) continue;
      out.push({ prNumber: pr.prNumber, prUrl: pr.prUrl, headSha: pr.headSha });
    }
    return out;
  }

  async createPr(args: {
    repo: string;
    branchName: string;
    baseBranch: string;
    title: string;
    body: string;
  }): Promise<{ prNumber: number; prUrl: string }> {
    const prNumber = this.nextPrNumber++;
    const prUrl = `https://github.example/${args.repo}/pull/${prNumber}`;
    // Head sha is provided by the caller via setHeadShaForNextPr() or
    // defaulted to the branch name's deterministic sha.
    const headSha = this.pendingHeadSha ?? fakeShaFromBranch(args.branchName);
    this.pendingHeadSha = undefined;
    this.prs.set(prNumber, {
      prNumber,
      prUrl,
      runId: this.pendingRunId ?? 'unknown-run',
      branchName: args.branchName,
      headSha,
      baseSha: args.baseBranch === this.baseBranch ? this.baseSha : this.baseSha,
      body: args.body,
    });
    this.pendingRunId = undefined;
    // Seed the live snapshot so hydrator sees a clean PR.
    this.live.set(prNumber, {
      prNumber,
      headSha,
      baseSha: this.baseSha,
      baseBranch: args.baseBranch,
      mergeableState: 'clean',
      state: 'open',
      protected: true,
      ...this.config.defaultPrSnapshot,
    });
    this.record('pr.create', { ...args, prNumber, prUrl });
    return { prNumber, prUrl };
  }

  /** Test helper: associate the next createPr() with a runId + head sha. */
  prepareNextPr(args: { runId: string; headSha: string }): void {
    this.pendingRunId = args.runId;
    this.pendingHeadSha = args.headSha;
  }

  /** ---- GitHubStateHydrator.TrustedGitHubPrPort ---- */

  async fetchPr(args: { repo: string; prNumber: number }): Promise<LivePrSnapshot | null> {
    const live = this.live.get(args.prNumber);
    if (!live) return null;
    // Honor a drift override so the negative test can force a different
    // current head sha than the one the gates were tested against.
    const override = this.headShaOverride.get(args.prNumber);
    if (override) {
      return { ...live, headSha: override };
    }
    return { ...live };
  }

  async fetchBranchProtection(args: {
    repo: string;
    baseBranch: string;
  }): Promise<BranchProtectionSnapshot | null> {
    void args;
    return { ...this.defaultProtection };
  }

  /** ---- IssueCloseService.IssueClosePort ---- */

  async closeIssue(args: { repo: string; issueNumber: number }): Promise<void> {
    this.record('issue.close', { ...args });
  }

  async removeLabel(args: {
    repo: string;
    issueNumber: number;
    label: string;
  }): Promise<void> {
    this.record('issue.label.remove', { ...args });
  }

  async addComment(args: { repo: string; issueNumber: number; body: string }): Promise<void> {
    this.record('issue.comment.add', { ...args });
  }

  /** ---- MergeService.MergeExecutionPort ---- */

  async merge(args: MergePortInput): Promise<{ mergeCommitSha: string }> {
    const prNumber = args.prNumber;
    const live = this.live.get(prNumber);
    const headSha = live?.headSha ?? this.baseSha;
    // Merge commit sha is a deterministic hash over (repo, prNumber, headSha).
    const mergeCommitSha = fakeMergeSha(args.repo, prNumber, headSha);
    this.record('pr.merge', { ...args, mergeCommitSha });
    // Reflect the merge in the live snapshot so subsequent reads see 'merged'.
    if (live) {
      this.live.set(prNumber, { ...live, state: 'merged' });
    }
    return { mergeCommitSha };
  }

  /** ---- Test helpers ---- */

  /** Simulate a force-push on a PR — the negative path uses this. */
  forcePush(prNumber: number, newHeadSha: string): void {
    this.headShaOverride.set(prNumber, newHeadSha);
  }

  /** Reset all recorded mutations (state retained for follow-up reads). */
  reset(): void {
    this.mutations.length = 0;
    this.seq = 0;
  }

  /** Return a snapshot copy of mutations, in call order. */
  recordedOperations(): readonly RecordedMutation[] {
    return [...this.mutations];
  }

  /** Convenience: list of mutation kinds in order. */
  recordedKinds(): readonly RecordedMutation['kind'][] {
    return this.mutations.map((m) => m.kind);
  }

  private pendingRunId?: string;
  private pendingHeadSha?: string;

  private record(kind: RecordedMutation['kind'], args: Record<string, unknown>): void {
    this.seq += 1;
    this.mutations.push({ kind, args, seq: this.seq });
  }
}

/** Local shape — kept private so we don't pollute the public interface. */
export interface FakePrRow {
  prNumber: number;
  prUrl: string;
  runId: string;
  branchName: string;
  headSha: string;
  baseSha: string;
  body: string;
}

/**
 * MergeService.MergeExecutionPort is structurally identical to the
 * `merge()` method on this class; we re-declare it here as a like-type
 * so callers can pass the FakeGitHubClient wherever a MergeExecutionPort
 * is expected.
 */
export interface MergeExecutionPortLike {
  merge(args: MergePortInput): Promise<{ mergeCommitSha: string }>;
}

/** Deterministic PR head sha derived from the branch name. */
export function fakeShaFromBranch(branchName: string): string {
  // 40-char sha-1-style string for compatibility with reviewResultSchema.
  let h = 0;
  for (let i = 0; i < branchName.length; i++) {
    h = (h * 31 + branchName.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  return (hex + 'f'.repeat(32)).slice(0, 40);
}

/** Deterministic merge commit sha. */
export function fakeMergeSha(repo: string, prNumber: number, headSha: string): string {
  let h = 0;
  const s = `${repo}#${prNumber}@${headSha}`;
  for (let i = 0; i < s.length; i++) {
    h = (h * 31 + s.charCodeAt(i)) >>> 0;
  }
  const hex = h.toString(16).padStart(8, '0');
  return (hex + 'a'.repeat(32)).slice(0, 40);
}

/** Re-export so test code does not need to import z directly. */
export type { z };

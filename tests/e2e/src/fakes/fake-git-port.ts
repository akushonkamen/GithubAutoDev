/**
 * FakeGitPort — implements BranchService.GitPort + CommitBuilder.GitCommitPort
 * for the e2e suite.
 *
 *   - resolveBaseSha returns a deterministic sha per (repo, issueNumber).
 *   - getOrCreateBranch is idempotent and tracks branches in memory.
 *   - readTree returns the seeded base contents (a tempdir fixture is
 *     used to feed the CommitBuilder; the FakeGitPort only seeds the
 *     base tree).
 *   - writeCommit lands a deterministic commit sha.
 *
 * No subprocess. No real git. This is the e2e fake — production wires
 * a real `git` CLI port.
 */

import { createHash } from 'node:crypto';
import type { GitCommitPort, GitPort } from '@cgao/orchestrator';

export interface FakeGitOptions {
  /** Default base sha (40 hex). Default: 40 zeros. */
  baseSha?: string;
}

/**
 * FakeGitPort satisfies both the BranchService GitPort and the
 * CommitBuilder GitCommitPort. The e2e test wires a single instance
 * into both services.
 */
export class FakeGitPort implements GitPort, GitCommitPort {
  private readonly branches = new Map<string, { baseSha: string }>();
  private readonly baseSha: string;
  private readonly baseTrees = new Map<string, Map<string, string>>();
  private readonly commits = new Map<string, { commitSha: string; changedFiles: string[] }>();
  private shaCounter = 0;

  constructor(opts: FakeGitOptions = {}) {
    this.baseSha = opts.baseSha ?? '0'.repeat(40);
  }

  /** ---- BranchService.GitPort ---- */

  async resolveBaseSha(args: {
    repo: string;
    issueNumber: number;
  }): Promise<string> {
    void args;
    // Stable per-fixture base sha. The fake's `baseSha` ctor arg is the
    // same value the FakeGitHubClient uses for its live PR snapshots so
    // the merge final evaluator's `current_base_sha === tested_base_sha`.
    return this.baseSha;
  }

  async getOrCreateBranch(args: {
    repo: string;
    branchName: string;
    baseSha: string;
  }): Promise<{ branchName: string; baseSha: string; created: boolean }> {
    const existing = this.branches.get(args.branchName);
    if (existing) {
      return { branchName: args.branchName, baseSha: existing.baseSha, created: false };
    }
    this.branches.set(args.branchName, { baseSha: args.baseSha });
    return { branchName: args.branchName, baseSha: args.baseSha, created: true };
  }

  /** ---- CommitBuilder.GitCommitPort ---- */

  async readTree(args: {
    branchName: string;
    baseSha: string;
  }): Promise<ReadonlyMap<string, string>> {
    void args;
    // Return the base tree the test seeded (or an empty tree).
    return this.baseTrees.get(args.branchName) ?? new Map();
  }

  async writeCommit(args: {
    branchName: string;
    baseSha: string;
    tree: ReadonlyMap<string, string>;
    commitMessage: string;
  }): Promise<{ commitSha: string; changedFiles: readonly string[] }> {
    const treeCanonical = [...args.tree.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const changedFiles = [...args.tree.keys()].sort();
    const payload = `${args.baseSha}\n${treeCanonical}\n${args.commitMessage}`;
    // Keep the full sha256-hex (71 chars total). Tests slice to 40 only
    // when feeding review-runner / merge-evaluator shapes that need a
    // 40-char git-style sha.
    const commitSha = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    this.commits.set(commitSha, {
      commitSha,
      changedFiles: [...changedFiles],
    });
    return { commitSha, changedFiles };
  }

  /** ---- Test helpers ---- */

  /** Seed the base tree (path → contents) the CommitBuilder will read. */
  seedBaseTree(branchName: string, tree: Map<string, string>): void {
    this.baseTrees.set(branchName, new Map(tree));
  }

  /** True iff a branch was created. */
  has(branchName: string): boolean {
    return this.branches.has(branchName);
  }

  /** Pre-seed a branch (rarely needed; create() already covers it). */
  seedBranch(branchName: string, baseSha: string): void {
    this.branches.set(branchName, { baseSha });
  }

  /** Override the base sha that resolveBaseSha returns. */
  setBaseSha(sha: string): void {
    // Overwrite future shaCounter-derived shas with a fixed value.
    (this as unknown as { baseSha: string }).baseSha = sha;
  }
}

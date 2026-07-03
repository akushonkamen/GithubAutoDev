/**
 * BranchService — T-M7-001, spec §12.8 / §15.
 *
 * Owns work-branch creation for cgao workflow runs. Idempotent: a
 * second `create()` with the same (runId, issueNumber, slug) returns
 * the existing branch ref instead of creating a duplicate.
 *
 * The service is intentionally port-driven: a `GitPort` interface
 * abstracts the actual `git branch` invocation so unit tests can
 * drive happy/error paths without subprocesses. The audit chain is
 * extended on every create so the before/after SHA is recoverable.
 */

import type { AuditChainService } from '@cgao/audit';
import { formatBranchName } from './naming-policy.js';

/** Read port the BranchService uses to talk to git. */
export interface GitPort {
  /** Return the SHA the work branch should be based on (the PR target's tip). */
  resolveBaseSha(args: { repo: string; issueNumber: number }): Promise<string>;
  /**
   * Create the branch if it does not exist. Return the branch ref.
   * Idempotent at the port level — re-creating returns the existing ref.
   */
  getOrCreateBranch(args: {
    repo: string;
    branchName: string;
    baseSha: string;
  }): Promise<{ branchName: string; baseSha: string; created: boolean }>;
}

export interface BranchServiceInput {
  runId: string;
  repo: string;
  issueNumber: number;
  /** Raw slug source (issue title or plan slug); will be normalized. */
  slug: string;
}

export interface BranchServiceResult {
  branchName: string;
  baseSha: string;
  /** Whether this call created a new branch (false = reused existing). */
  created: boolean;
  /** Normalized slug. */
  slug: string;
}

export interface BranchServiceDeps {
  git: GitPort;
  audit: AuditChainService;
}

export class BranchService {
  constructor(private readonly deps: BranchServiceDeps) {}

  async create(input: BranchServiceInput): Promise<BranchServiceResult> {
    // Naming policy throws on bad slug; let it propagate to the caller
    // so they can map to a 4xx without leaking raw input into logs.
    const { branchName, slug } = formatBranchName({
      issueNumber: input.issueNumber,
      slug: input.slug,
    });

    const baseSha = await this.deps.git.resolveBaseSha({
      repo: input.repo,
      issueNumber: input.issueNumber,
    });

    const outcome = await this.deps.git.getOrCreateBranch({
      repo: input.repo,
      branchName,
      baseSha,
    });

    // Audit: before/after SHA. `created` flag tells the reconciler
    // whether this was a fresh branch or a dedup'd reuse.
    await this.deps.audit.append({
      runId: input.runId,
      kind: 'branch.create',
      payload: {
        repo: input.repo,
        issueNumber: input.issueNumber,
        branchName,
        slug,
        baseSha,
        created: outcome.created,
      },
    });

    return {
      branchName: outcome.branchName,
      baseSha,
      created: outcome.created,
      slug,
    };
  }
}

/** In-memory GitPort for unit tests and dev runs. */
export class InMemoryGitPort implements GitPort {
  private readonly branches = new Map<string, { baseSha: string }>();
  private baseShaCounter = 0;

  async resolveBaseSha(): Promise<string> {
    // Deterministic fake base sha for tests.
    this.baseShaCounter += 1;
    return fakeSha(this.baseShaCounter);
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

  /** Test helper: pre-seed a branch to simulate an existing ref. */
  seed(branchName: string, baseSha: string): void {
    this.branches.set(branchName, { baseSha });
  }

  /** Test helper: did a branch get created? */
  has(branchName: string): boolean {
    return this.branches.has(branchName);
  }
}

function fakeSha(n: number): string {
  return `sha256:${n.toString(16).padStart(64, '0')}`;
}

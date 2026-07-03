/**
 * CommitBuilder — T-M7-002, spec §12.8 / §12.11.
 *
 * Applies a WorkerResult patch on top of a work branch and produces
 * an atomic commit. Before any commit is written:
 *
 *   1. The patch is run through the M5 clean-checkout applier so the
 *      commit is never based on a dirty work tree (spec §13.3).
 *   2. The ProtectedFileDetector scans changedFiles; any match aborts
 *      the commit and audits `PROTECTED_FILE_VIOLATION`.
 *
 * The commit sha is the deterministic sha256 of (baseSha || tree sha
 * || message). Real git computes this server-side; the in-memory port
 * reproduces it for tests so two commits over the same inputs produce
 * the same sha (idempotence / reproducibility).
 */

import { createHash } from 'node:crypto';
import type { AuditChainService } from '@cgao/audit';
import {
  type OverlayEntry,
  ProtectedFileDetector,
  applyToCleanCheckout,
} from '@cgao/runner-broker';
import { renderCommitMessage } from './commit-message-renderer.js';

/** What the dev module / runner hands us. */
export interface WorkerResultPatch {
  /** SHA the patch was generated against. */
  baseSha: string;
  /** Overlay entries — file contents to apply. */
  entries: readonly OverlayEntry[];
  /** Allowed paths (plan task's allowedPaths). */
  allowedPaths: readonly string[];
  /** Forbidden paths (plan task's forbiddenPaths). */
  forbiddenPaths: readonly string[];
}

export interface BuildCommitInput {
  runId: string;
  /** The work branch the commit should land on. */
  branchName: string;
  /** Patch to apply. */
  patch: WorkerResultPatch;
  /** Commit message input (summary + traceability). */
  message: {
    summary: string;
    issueNumber: number;
    runId: string;
    specId: string;
    planId: string;
    planSha: string;
    body?: readonly string[];
  };
  /** Base contents (path → contents) at baseSha; supplied by the GitPort. */
  base: ReadonlyMap<string, string>;
}

export interface BuildCommitResult {
  /** Either 'committed' or 'aborted'. */
  decision: 'committed' | 'aborted';
  /** Commit sha when committed; violation reason when aborted. */
  commitSha?: string;
  /** Files the commit touched. */
  changedFiles: readonly string[];
  /** Reasons for abort (empty on commit). */
  reasons: readonly string[];
}

/** Read port the CommitBuilder uses to land a commit. */
export interface GitCommitPort {
  /** Read the file contents at a base sha (path → contents). */
  readTree(args: { branchName: string; baseSha: string }): Promise<ReadonlyMap<string, string>>;
  /** Land a commit; returns the new commit sha. */
  writeCommit(args: {
    branchName: string;
    baseSha: string;
    /** Post-apply tree (path → contents). */
    tree: ReadonlyMap<string, string>;
    commitMessage: string;
  }): Promise<{ commitSha: string; changedFiles: readonly string[] }>;
}

export interface CommitBuilderDeps {
  git: GitCommitPort;
  audit: AuditChainService;
  /** Optional detector override; defaults to the standard patterns. */
  protectedFileDetector?: ProtectedFileDetector;
}

export const PROTECTED_FILE_VIOLATION = 'PROTECTED_FILE_VIOLATION' as const;

export class CommitBuilder {
  private readonly detector: ProtectedFileDetector;

  constructor(private readonly deps: CommitBuilderDeps) {
    this.detector = deps.protectedFileDetector ?? new ProtectedFileDetector();
  }

  async build(input: BuildCommitInput): Promise<BuildCommitResult> {
    // 1. Validate patch + apply to a CLEAN in-memory checkout of base.
    //    applyToCleanCheckout enforces allowedPaths/forbiddenPaths and
    //    rejects deletions of protected files.
    const applied = applyToCleanCheckout({
      baseSha: input.patch.baseSha,
      entries: input.patch.entries,
      base: input.base,
      allowedPaths: input.patch.allowedPaths,
      forbiddenPaths: input.patch.forbiddenPaths,
      protectedFileDetector: this.detector,
    });
    if (applied.decision === 'rejected') {
      // The clean-checkout applier already produced reasons; surface them.
      await this.deps.audit.append({
        runId: input.runId,
        kind: PROTECTED_FILE_VIOLATION,
        payload: {
          branchName: input.branchName,
          baseSha: input.patch.baseSha,
          reasons: applied.reasons,
          changedFiles: applied.changedFiles,
        },
      });
      return {
        decision: 'aborted',
        changedFiles: applied.changedFiles,
        reasons: applied.reasons,
      };
    }

    // 2. Protected-file sweep over changedFiles (defense in depth —
    //    the applier blocks *deletions* of protected files, but we
    //    also reject any *modification* of a protected path that the
    //    task allow-list happened to permit).
    const protectedTouched = applied.changedFiles.filter((p) => this.detector.isProtected(p));
    if (protectedTouched.length > 0) {
      const reasons = protectedTouched.map((p) => `protected file touched: ${p}`);
      await this.deps.audit.append({
        runId: input.runId,
        kind: PROTECTED_FILE_VIOLATION,
        payload: {
          branchName: input.branchName,
          baseSha: input.patch.baseSha,
          reasons,
          changedFiles: applied.changedFiles,
          protectedTouched,
        },
      });
      return {
        decision: 'aborted',
        changedFiles: applied.changedFiles,
        reasons,
      };
    }

    // 3. Render commit message (throws on bad summary — surfaces to caller).
    const commitMessage = renderCommitMessage(input.message);

    // 4. Land the commit via the git port.
    const written = await this.deps.git.writeCommit({
      branchName: input.branchName,
      baseSha: input.patch.baseSha,
      tree: applied.result,
      commitMessage,
    });

    // 5. Audit the commit creation.
    await this.deps.audit.append({
      runId: input.runId,
      kind: 'commit.create',
      payload: {
        branchName: input.branchName,
        baseSha: input.patch.baseSha,
        commitSha: written.commitSha,
        changedFiles: written.changedFiles,
      },
    });

    return {
      decision: 'committed',
      commitSha: written.commitSha,
      changedFiles: written.changedFiles,
      reasons: [],
    };
  }
}

/** In-memory GitCommitPort for tests. Deterministic commit sha. */
export class InMemoryGitCommitPort implements GitCommitPort {
  async readTree(): Promise<ReadonlyMap<string, string>> {
    return new Map();
  }

  async writeCommit(args: {
    branchName: string;
    baseSha: string;
    tree: ReadonlyMap<string, string>;
    commitMessage: string;
  }): Promise<{ commitSha: string; changedFiles: readonly string[] }> {
    // Deterministic fake commit sha over (baseSha || tree || message).
    const treeCanonical = [...args.tree.entries()]
      .map(([k, v]) => `${k}=${v}`)
      .sort()
      .join('\n');
    const changedFiles = [...args.tree.keys()].sort();
    const payload = `${args.baseSha}\n${treeCanonical}\n${args.commitMessage}`;
    const commitSha = `sha256:${createHash('sha256').update(payload).digest('hex')}`;
    return { commitSha, changedFiles };
  }
}

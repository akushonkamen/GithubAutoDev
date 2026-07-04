/**
 * Subprocess-backed GitPort + GitCommitPort — Plan B Phase 1.
 *
 * Implements both ports (BranchService.GitPort + CommitBuilder.GitCommitPort)
 * using the real `git` CLI through child processes. This is the trusted
 * transport that lands commits against the work-tree checkout owned by
 * the Trusted Control Runner (spec §6.4 / §13.3).
 *
 * Security:
 *   - `repoRoot` MUST be absolute. Refuses anything else.
 *   - Path traversal in tree paths is rejected before reaching git.
 *   - No shell invocation — `execFile` only — so branch names / paths
 *     cannot inject argv flags.
 *
 * The adapter is stateless: each invocation spawns a fresh git process.
 * Caller (the orchestrator) wires one instance per repo-root.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, normalize, relative, resolve as resolvePath } from 'node:path';
import { promisify } from 'node:util';
import type { GitCommitPort, GitPort } from '../index.js';

const execFileP = promisify(execFile);

export interface GitSubprocessOptions {
  /**
   * Absolute path to the git repo working tree. The adapter refuses
   * relative paths; production wiring must resolve this once at boot.
   */
  repoRoot: string;
  /**
   * Optional override of the `git` binary path. Defaults to `'git'`
   * resolved from PATH.
   */
  gitBin?: string;
  /** Per-call timeout (ms). Default 30s. */
  timeoutMs?: number;
}

/** Standard commit marker so the audit chain can attribute these commits. */
const COMMIT_MARKER = '[cgao:git-subprocess]';

/**
 * Adapter that satisfies BranchService.GitPort + CommitBuilder.GitCommitPort
 * by shelling out to `git` against a single repo-root.
 */
export class GitSubprocessAdapter implements GitPort, GitCommitPort {
  private readonly repoRoot: string;
  private readonly gitBin: string;
  private readonly timeoutMs: number;

  constructor(opts: GitSubprocessOptions) {
    if (!opts.repoRoot.startsWith('/')) {
      throw new Error(`GitSubprocessAdapter: repoRoot must be absolute, got "${opts.repoRoot}"`);
    }
    this.repoRoot = resolvePath(opts.repoRoot);
    this.gitBin = opts.gitBin ?? 'git';
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  /** ---- GitPort ---- */

  /**
   * Resolve the base sha for an issue — i.e. the tip of the PR target branch.
   *
   * We fetch origin first so the rev is current, then `git rev-parse`
   * the configured base branch (main unless overridden via env
   * `CGAO_BASE_BRANCH`). The result is a 40-char lowercase hex sha.
   */
  async resolveBaseSha(args: { repo: string; issueNumber: number }): Promise<string> {
    void args; // BranchService passes issueNumber for portability; not used here.
    await this.runGit(['fetch', '--quiet', 'origin']);
    const branch = process.env.CGAO_BASE_BRANCH ?? 'main';
    const { stdout } = await this.runGit(['rev-parse', `refs/remotes/origin/${branch}`]);
    const sha = stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`resolveBaseSha: unexpected sha "${sha}" for origin/${branch}`);
    }
    return sha;
  }

  /**
   * Create a branch pointing at baseSha, idempotently. Re-running with the
   * same branchName resets the existing ref to the new baseSha via
   * `git branch --force` (caller is responsible for not stomping live work).
   */
  async getOrCreateBranch(args: {
    repo: string;
    branchName: string;
    baseSha: string;
  }): Promise<{ branchName: string; baseSha: string; created: boolean }> {
    if (!/^[A-Za-z0-9._/-]+$/.test(args.branchName)) {
      throw new Error(`getOrCreateBranch: invalid branch name "${args.branchName}"`);
    }
    if (!/^[0-9a-f]{40}$/.test(args.baseSha)) {
      throw new Error(`getOrCreateBranch: invalid base sha "${args.baseSha}"`);
    }
    const existed = await this.branchExists(args.branchName);
    // Reset / create via update-ref so we don't depend on a worktree checkout.
    await this.runGit(['update-ref', `refs/heads/${args.branchName}`, args.baseSha]);
    return { branchName: args.branchName, baseSha: args.baseSha, created: !existed };
  }

  /** ---- GitCommitPort ---- */

  /**
   * Read the tree at baseSha as path→contents. Implemented via `git ls-tree
   * -r -z` plus blob reads. Returns an empty Map for the empty tree.
   */
  async readTree(args: {
    branchName: string;
    baseSha: string;
  }): Promise<ReadonlyMap<string, string>> {
    if (!/^[0-9a-f]{40}$/.test(args.baseSha)) {
      throw new Error(`readTree: invalid base sha "${args.baseSha}"`);
    }
    const out = new Map<string, string>();
    // Default ls-tree -r -z format: `<mode> <type> <object>\t<path>\0`.
    // Stable across git versions — the `--format=` flag's escape handling
    // varies between versions, so we parse the default form.
    const { stdout } = await this.runGit(['ls-tree', '-r', '-z', args.baseSha]);
    if (stdout.length === 0) return out;
    for (const entry of stdout.split('\0')) {
      if (!entry) continue;
      const tabIdx = entry.indexOf('\t');
      if (tabIdx < 0) continue;
      const meta = entry.slice(0, tabIdx);
      const path = entry.slice(tabIdx + 1);
      // meta looks like "<mode> <type> <object>"
      const parts = meta.split(/\s+/);
      const type = parts[1];
      const objectname = parts[2];
      if (!path || !objectname || type !== 'blob') continue;
      assertSafePath(path);
      const { stdout: blob } = await this.runGit(['cat-file', 'blob', objectname]);
      out.set(path, blob);
    }
    return out;
  }

  /**
   * Land a commit on branchName with the supplied tree. Implemented by
   * writing the post-apply tree to a temp index file, then `git commit-tree`.
   * The branch ref is updated to the new commit. Returns the new sha plus
   * the sorted list of changed file paths.
   */
  async writeCommit(args: {
    branchName: string;
    baseSha: string;
    tree: ReadonlyMap<string, string>;
    commitMessage: string;
  }): Promise<{ commitSha: string; changedFiles: readonly string[] }> {
    if (!/^[0-9a-f]{40}$/.test(args.baseSha)) {
      throw new Error(`writeCommit: invalid base sha "${args.baseSha}"`);
    }
    if (!/^[A-Za-z0-9._/-]+$/.test(args.branchName)) {
      throw new Error(`writeCommit: invalid branch name "${args.branchName}"`);
    }
    const changedFiles = [...args.tree.keys()].sort();
    // Build a fresh tree object from the post-apply map. We stage every
    // entry against an empty-tree index so removed files fall away
    // naturally (the applier already excluded them).
    const tmpIndex = await mkdtemp(join(tmpdir(), 'cgao-index-'));
    try {
      const indexPath = join(tmpIndex, 'index');
      const env = { ...process.env, GIT_INDEX_FILE: indexPath };
      // Read the base tree into the index, then overlay new contents.
      await this.runGit(['read-tree', args.baseSha], env);
      for (const [path, contents] of args.tree) {
        assertSafePath(path);
        const abs = join(this.repoRoot, path);
        const dir = resolvePath(abs, '..');
        await mkdir(dir, { recursive: true });
        await writeFile(abs, contents, 'utf8');
        await this.runGit(['add', '--', path], env);
      }
      // Capture the tree object.
      const { stdout: treeSha } = await this.runGit(['write-tree'], env);
      const tree = treeSha.trim();
      if (!/^[0-9a-f]{40}$/.test(tree)) {
        throw new Error(`writeCommit: invalid tree sha "${tree}"`);
      }
      const parent = args.baseSha;
      const { stdout: commitShaRaw } = await this.runGit(
        ['commit-tree', tree, '-p', parent, '-m', `${args.commitMessage}\n\n${COMMIT_MARKER}`],
        env,
      );
      const commitSha = commitShaRaw.trim();
      if (!/^[0-9a-f]{40}$/.test(commitSha)) {
        throw new Error(`writeCommit: invalid commit sha "${commitSha}"`);
      }
      await this.runGit(['update-ref', `refs/heads/${args.branchName}`, commitSha]);
      return { commitSha, changedFiles };
    } finally {
      await rm(tmpIndex, { recursive: true, force: true });
    }
  }

  /** ---- Helpers ---- */

  private async branchExists(branchName: string): Promise<boolean> {
    try {
      await this.runGit(['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async runGit(
    args: readonly string[],
    envOverride?: NodeJS.ProcessEnv,
  ): Promise<{
    stdout: string;
    stderr: string;
  }> {
    try {
      const { stdout, stderr } = await execFileP(this.gitBin, args as string[], {
        cwd: this.repoRoot,
        env: envOverride ?? process.env,
        timeout: this.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
      void stderr;
      return { stdout: String(stdout), stderr: String(stderr) };
    } catch (err) {
      const e = err as { stderr?: string; message?: string };
      const tail = (e.stderr ?? e.message ?? '').slice(-500);
      throw new Error(`git ${args.join(' ')} failed in ${this.repoRoot}: ${tail}`);
    }
  }
}

/**
 * Reject path traversal: must be relative, must not escape the repo root,
 * must not contain `..` components, must not start with `/`.
 */
export function assertSafePath(p: string): void {
  if (p === '') throw new Error('assertSafePath: empty path');
  if (p.startsWith('/')) throw new Error(`assertSafePath: absolute path not allowed: "${p}"`);
  if (normalize(p) !== p) {
    throw new Error(`assertSafePath: non-normalized path not allowed: "${p}"`);
  }
  if (p.includes('..')) {
    throw new Error(`assertSafePath: path traversal not allowed: "${p}"`);
  }
  const abs = resolvePath('/', p);
  const rel = relative('/', abs);
  if (rel.startsWith('..')) {
    throw new Error(`assertSafePath: path escapes root: "${p}"`);
  }
}

/** Deterministic sha for the empty tree sentinel. */
export function emptyTreeSha(): string {
  return createHash('sha1').update('').digest('hex');
}

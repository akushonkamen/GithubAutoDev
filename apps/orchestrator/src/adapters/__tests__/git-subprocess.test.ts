/**
 * GitSubprocessAdapter — real git CLI tests.
 *
 * Each test mints a tempdir, `git init`s it, seeds an initial commit
 * on `main`, then drives the adapter and asserts the resulting refs /
 * tree contents. Requires `git` on PATH; CI skips this if missing.
 *
 * These tests are hermetic — no network, no fixtures on disk — but they
 * do spawn real git subprocesses, so they take ~50-100ms each.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GitSubprocessAdapter, assertSafePath } from '../git-subprocess.js';

const execFileP = promisify(execFile);

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileP('git', args as string[], {
    cwd,
    env: {
      ...process.env,
      // Deterministic identity so commits don't fail in CI.
      GIT_AUTHOR_NAME: 'cgao-test',
      GIT_AUTHOR_EMAIL: 'cgao-test@example.com',
      GIT_COMMITTER_NAME: 'cgao-test',
      GIT_COMMITTER_EMAIL: 'cgao-test@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null',
    },
  });
  return String(stdout);
}

async function seedRepo(root: string): Promise<{ mainSha: string }> {
  await git(['init', '-q', '--initial-branch=main'], root);
  await git(['config', 'user.name', 'cgao-test'], root);
  await git(['config', 'user.email', 'cgao-test@example.com'], root);
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# initial\n', 'utf8');
  await writeFile(join(root, 'src', 'hello.txt'), 'hello\n', 'utf8');
  await git(['add', '.'], root);
  await git(['commit', '-q', '-m', 'initial'], root);
  await git(['branch', '-M', 'main'], root);
  const mainSha = (await git(['rev-parse', 'HEAD'], root)).trim();
  return { mainSha };
}

const describeGit = process.env.CGAO_SKIP_GIT_TESTS === '1' ? describe.skip : describe;

describeGit('GitSubprocessAdapter', () => {
  let root: string;
  let mainSha: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'cgao-git-test-'));
    const seeded = await seedRepo(root);
    mainSha = seeded.mainSha;
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it('rejects non-absolute repoRoot at construction', () => {
    expect(() => new GitSubprocessAdapter({ repoRoot: './relative' })).toThrow(/absolute/);
  });

  it('resolveBaseSha returns the main sha after a no-op fetch fallback', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    // No remote exists, so fetch will fail. resolveBaseSha should surface the
    // git error rather than silently returning a wrong sha.
    await expect(adapter.resolveBaseSha({ repo: 'o/r', issueNumber: 1 })).rejects.toThrow(
      /git fetch/,
    );
  });

  it('getOrCreateBranch creates a branch ref pointing at baseSha', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    const out = await adapter.getOrCreateBranch({
      repo: 'o/r',
      branchName: 'cgao/issue-1',
      baseSha: mainSha,
    });
    expect(out.created).toBe(true);
    expect(out.baseSha).toBe(mainSha);
    const ref = (await git(['rev-parse', 'refs/heads/cgao/issue-1'], root)).trim();
    expect(ref).toBe(mainSha);
    // Re-running is idempotent: created=false, ref unchanged.
    const out2 = await adapter.getOrCreateBranch({
      repo: 'o/r',
      branchName: 'cgao/issue-1',
      baseSha: mainSha,
    });
    expect(out2.created).toBe(false);
  });

  it('getOrCreateBranch rejects invalid branch names and shas', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    await expect(
      adapter.getOrCreateBranch({
        repo: 'o/r',
        branchName: 'bad;rm -rf /',
        baseSha: mainSha,
      }),
    ).rejects.toThrow(/invalid branch name/);
    await expect(
      adapter.getOrCreateBranch({
        repo: 'o/r',
        branchName: 'cgao/x',
        baseSha: 'not-a-sha',
      }),
    ).rejects.toThrow(/invalid base sha/);
  });

  it('readTree returns the file contents at baseSha', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    const tree = await adapter.readTree({ branchName: 'main', baseSha: mainSha });
    expect(tree.get('README.md')).toBe('# initial\n');
    expect(tree.get('src/hello.txt')).toBe('hello\n');
  });

  it('writeCommit lands a new commit on a branch with the overlay tree', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    const branch = 'cgao/write-test';
    await adapter.getOrCreateBranch({
      repo: 'o/r',
      branchName: branch,
      baseSha: mainSha,
    });
    const overlay = new Map<string, string>([
      ['README.md', '# updated\n'],
      ['src/new.txt', 'new\n'],
    ]);
    const out = await adapter.writeCommit({
      branchName: branch,
      baseSha: mainSha,
      tree: overlay,
      commitMessage: 'cgao: update README + add new file',
    });
    expect(out.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(out.changedFiles).toEqual(['README.md', 'src/new.txt']);
    // Branch ref moved to the new commit.
    const ref = (await git(['rev-parse', `refs/heads/${branch}`], root)).trim();
    expect(ref).toBe(out.commitSha);
    // File contents actually present in the commit.
    const blob = (await git(['show', `${out.commitSha}:README.md`], root)).trim();
    expect(blob).toBe('# updated');
    const blob2 = (await git(['show', `${out.commitSha}:src/new.txt`], root)).trim();
    expect(blob2).toBe('new');
  });

  it('writeCommit rejects path traversal in tree keys', async () => {
    const adapter = new GitSubprocessAdapter({ repoRoot: root });
    const bad = new Map<string, string>([['../escape.txt', 'x']]);
    await expect(
      adapter.writeCommit({
        branchName: 'cgao/x',
        baseSha: mainSha,
        tree: bad,
        commitMessage: 'evil',
      }),
    ).rejects.toThrow(/assertSafePath|path traversal|non-normalized/);
  });
});

describe('assertSafePath', () => {
  it('accepts relative normalized paths', () => {
    expect(() => assertSafePath('src/hello.txt')).not.toThrow();
    expect(() => assertSafePath('a/b/c.txt')).not.toThrow();
  });
  it('rejects absolute, traversal, and non-normalized', () => {
    expect(() => assertSafePath('/etc/passwd')).toThrow(/absolute/);
    expect(() => assertSafePath('a/../b')).toThrow();
    expect(() => assertSafePath('../escape')).toThrow(/traversal|escapes/);
    expect(() => assertSafePath('')).toThrow(/empty/);
  });
});

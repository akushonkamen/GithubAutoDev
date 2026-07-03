/**
 * Prompt artifact loader — T-M5-002, spec §13 / §17.
 *
 * Resolves `artifact://handoff/<sha>` (and other artifact URIs) to a
 * local file path under `cgao-artifacts/`. The CCA workflow uses this
 * to fetch the prompt it should hand to `claude-code-action`.
 *
 * M5 ships a stub fetcher that reads from a local directory; the real
 * ArtifactStore-backed fetcher lands when the workflow runs in CI
 * (T-M5-002 acceptance: "可触发 analyst/planner/executor/reviewer 基础任务").
 */

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/**
 * Canonical artifact URI form: `artifact://<kind>/<sha>`.
 * kind ∈ {handoff, plan, spec, review, worker_result, ...}.
 */
export const ARTIFACT_URI_RE = /^artifact:\/\/([a-z_]+)\/([0-9a-f]{64}|sha256:[0-9a-f]{64})$/u;

export interface ResolvedArtifact {
  /** URI that was resolved. */
  uri: string;
  /** Kind segment from the URI (e.g. 'handoff'). */
  kind: string;
  /** SHA segment from the URI (hex digest, no `sha256:` prefix). */
  sha: string;
  /** Absolute filesystem path the artifact was loaded from. */
  path: string;
  /** Artifact content (UTF-8). */
  content: string;
}

export class ArtifactResolutionError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_URI' | 'NOT_FOUND' | 'READ_ERROR',
  ) {
    super(message);
    this.name = 'ArtifactResolutionError';
  }
}

/**
 * Stub fetcher: reads `cgao-artifacts/<kind>/<sha>` relative to `root`
 * (defaults to `process.cwd()`). The CCA workflow pre-populates this
 * directory before invoking the runner.
 */
export class PromptLoader {
  constructor(private readonly root: string = process.cwd()) {}

  async resolve(uri: string): Promise<ResolvedArtifact> {
    const match = ARTIFACT_URI_RE.exec(uri);
    if (!match) {
      throw new ArtifactResolutionError(`invalid artifact uri: ${uri}`, 'INVALID_URI');
    }
    const kind = match[1] ?? '';
    const rawSha = match[2] ?? '';
    const sha = rawSha.startsWith('sha256:') ? rawSha.slice('sha256:'.length) : rawSha;
    const path = resolve(join(this.root, 'cgao-artifacts', kind, sha));
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch (cause) {
      const err = cause as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        throw new ArtifactResolutionError(
          `artifact not found: ${uri} (looked at ${path})`,
          'NOT_FOUND',
        );
      }
      throw new ArtifactResolutionError(
        `failed to read artifact ${uri}: ${err.message}`,
        'READ_ERROR',
      );
    }
    return { uri, kind, sha, path, content };
  }

  /**
   * Convenience: resolve and return only the content. Used by the CCA
   * entrypoint when it just needs the prompt body.
   */
  async load(uri: string): Promise<string> {
    return (await this.resolve(uri)).content;
  }
}

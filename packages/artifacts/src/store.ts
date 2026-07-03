/**
 * Concrete ArtifactStore adapters — T-M2-004, spec §11 / §15.
 *
 *  - InMemoryArtifactStore: unit tests / startup mode
 *  - FsArtifactStore: local-filesystem backed (single-node deploy,
 *    dev, CI). Production swaps in an S3 adapter on the same interface.
 *
 * Both write content-addressed: identical content always produces the
 * same key, so a re-write is a no-op. Producers SHOULD call computeArtifactKey
 * to derive the key — never construct keys by hand.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  type Artifact,
  type ArtifactKind,
  type ArtifactStore,
  computeArtifactKey,
} from './index.js';

export class InMemoryArtifactStore implements ArtifactStore {
  private readonly rows = new Map<string, Artifact>();

  async write(artifact: Artifact): Promise<void> {
    // Idempotent: same key -> same content, no error on re-write.
    this.rows.set(artifact.key, artifact);
  }

  async read(key: string): Promise<Artifact | null> {
    const row = this.rows.get(key);
    return row ? { ...row } : null;
  }

  async list(filter: { repo: string; runId?: string; kind?: ArtifactKind }): Promise<Artifact[]> {
    const out: Artifact[] = [];
    for (const row of this.rows.values()) {
      if (row.repo !== filter.repo) continue;
      if (filter.runId !== undefined && row.runId !== filter.runId) continue;
      if (filter.kind !== undefined && row.kind !== filter.kind) continue;
      out.push({ ...row });
    }
    return out;
  }

  size(): number {
    return this.rows.size;
  }
}

/**
 * Filesystem-backed store. Layout:
 *   <root>/<first-2-of-sha>/<full-sha>.json
 *
 * Sharding by the first 2 hex chars avoids >10k files in one dir.
 */
export class FsArtifactStore implements ArtifactStore {
  constructor(private readonly root: string) {}

  async write(artifact: Artifact): Promise<void> {
    const path = this.pathFor(artifact.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(artifact), 'utf8');
  }

  async read(key: string): Promise<Artifact | null> {
    try {
      const buf = await readFile(this.pathFor(key), 'utf8');
      return JSON.parse(buf) as Artifact;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw cause;
    }
  }

  async list(filter: { repo: string; runId?: string; kind?: ArtifactKind }): Promise<Artifact[]> {
    const out: Artifact[] = [];
    let buckets: string[];
    try {
      buckets = await readdir(this.root);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw cause;
    }
    for (const bucket of buckets) {
      const files = await readdir(join(this.root, bucket));
      for (const f of files) {
        const buf = await readFile(join(this.root, bucket, f), 'utf8');
        const row = JSON.parse(buf) as Artifact;
        if (row.repo !== filter.repo) continue;
        if (filter.runId !== undefined && row.runId !== filter.runId) continue;
        if (filter.kind !== undefined && row.kind !== filter.kind) continue;
        out.push(row);
      }
    }
    return out;
  }

  private pathFor(key: string): string {
    const sha = key.replace(/^sha256:/u, '');
    const bucket = sha.slice(0, 2);
    return join(this.root, bucket, `${sha}.json`);
  }
}

export { computeArtifactKey };

/**
 * ArtifactStore adapter regression — T-M2-004, spec §11 / §15.
 *
 * Locks the contract every adapter must satisfy:
 *  - write is idempotent (same content -> same key, re-write is no-op)
 *  - read returns null for missing keys
 *  - list filters by repo / runId / kind
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type Artifact,
  type ArtifactStore,
  FsArtifactStore,
  InMemoryArtifactStore,
  computeArtifactKey,
} from '../index.js';

function sample(opts: {
  repo?: string;
  runId?: string | null;
  kind?: Artifact['kind'];
  content?: string;
}): Artifact {
  const content = opts.content ?? 'hello world';
  return {
    kind: opts.kind ?? 'spec',
    key: computeArtifactKey(content),
    content,
    repo: opts.repo ?? 'cgao/test',
    runId: opts.runId === undefined ? 'run_1' : opts.runId,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

function runSuite(name: string, factory: () => Promise<ArtifactStore>): void {
  describe(name, () => {
    let store: ArtifactStore;
    beforeEach(async () => {
      store = await factory();
    });

    it('writes and reads back by content-key', async () => {
      const a = sample({ content: 'abc' });
      await store.write(a);
      const got = await store.read(a.key);
      expect(got?.content).toBe('abc');
    });

    it('write is idempotent (same content twice, no error)', async () => {
      const a = sample({ content: 'xyz' });
      await store.write(a);
      await store.write(a);
      const got = await store.read(a.key);
      expect(got?.key).toBe(a.key);
    });

    it('returns null for unknown key', async () => {
      const got = await store.read(
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      );
      expect(got).toBeNull();
    });

    it('list filters by repo', async () => {
      await store.write(sample({ repo: 'cgao/a', content: 'a' }));
      await store.write(sample({ repo: 'cgao/b', content: 'b' }));
      const list = await store.list({ repo: 'cgao/a' });
      expect(list.map((x) => x.repo)).toEqual(['cgao/a']);
    });

    it('list filters by runId', async () => {
      await store.write(sample({ runId: 'run_1', content: 'a' }));
      await store.write(sample({ runId: 'run_2', content: 'b' }));
      const list = await store.list({ repo: 'cgao/test', runId: 'run_2' });
      expect(list.map((x) => x.runId)).toEqual(['run_2']);
    });

    it('list filters by kind', async () => {
      await store.write(sample({ kind: 'spec', content: 's' }));
      await store.write(sample({ kind: 'plan', content: 'p' }));
      const list = await store.list({ repo: 'cgao/test', kind: 'plan' });
      expect(list.map((x) => x.kind)).toEqual(['plan']);
    });

    it('produces stable keys for identical content', async () => {
      const a = sample({ content: 'stable' });
      const b = sample({ content: 'stable', runId: 'other' });
      expect(a.key).toBe(b.key);
    });
  });
}

runSuite('InMemoryArtifactStore', async () => new InMemoryArtifactStore());

describe('FsArtifactStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cgao-art-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  runSuite('FsArtifactStore', async () => new FsArtifactStore(root));

  it('survives re-instantiation (content persists on disk)', async () => {
    const store1 = new FsArtifactStore(root);
    const a = sample({ content: 'persist' });
    await store1.write(a);
    const store2 = new FsArtifactStore(root);
    const got = await store2.read(a.key);
    expect(got?.content).toBe('persist');
  });

  it('returns empty list when root does not exist', async () => {
    const store = new FsArtifactStore(join(root, 'missing'));
    const list = await store.list({ repo: 'cgao/test' });
    expect(list).toEqual([]);
  });
});

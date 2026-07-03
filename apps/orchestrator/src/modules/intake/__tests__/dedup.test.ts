/**
 * Intake Deduplicator — T-INTAKE-006.
 *
 * Verifies dedup_key triple uniqueness, 24h window, and that repeated
 * triggers return the existing session.
 */

import { describe, expect, it } from 'vitest';
import {
  type DedupResolution,
  Deduplicator,
  InMemoryDedupStore,
  canonicalIntakeContent,
  computeDedupKey,
  hashIntakeContent,
} from '../dedup.js';

describe('canonicalIntakeContent', () => {
  it('trims and collapses internal whitespace', () => {
    expect(canonicalIntakeContent('  hello   world  ')).toBe('hello world');
  });

  it('normalizes Unicode to NFC', () => {
    const nfd = 'café'.normalize('NFD');
    expect(canonicalIntakeContent(nfd)).toBe('café'.normalize('NFC'));
  });
});

describe('computeDedupKey (T-INTAKE-006)', () => {
  it('produces source|external|content_hash', () => {
    const key = computeDedupKey({
      sourceType: 'lark',
      externalId: 'chat1:msg1',
      content: 'help',
    });
    const [src, ext, hash] = key.split('|');
    expect(src).toBe('lark');
    expect(ext).toBe('chat1:msg1');
    expect(hash).toBe(hashIntakeContent('help'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('produces same hash for whitespace-only-different content', () => {
    const a = computeDedupKey({
      sourceType: 'lark',
      externalId: 'm1',
      content: 'hello   world',
    });
    const b = computeDedupKey({
      sourceType: 'lark',
      externalId: 'm1',
      content: '  hello world  ',
    });
    expect(a).toBe(b);
  });
});

describe('Deduplicator.resolve (T-INTAKE-006)', () => {
  it('claims a new dedup_key and reports duplicate=false', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store, 24 * 60);
    const r: DedupResolution = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm1', content: 'deploy broken' },
      { sessionId: 's1' },
    );
    expect(r.duplicate).toBe(false);
    expect(r.dedupKey).toContain('lark|m1|');
  });

  it('returns the existing session when same dedup_key arrives in-window', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store, 24 * 60);
    const first = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm1', content: 'deploy broken' },
      { sessionId: 's1', now: new Date('2026-07-03T10:00:00Z') },
    );
    store.attachIssueUrl(first.dedupKey, 'https://github.com/o/r/issues/42');
    const second = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm1', content: 'deploy broken' },
      { sessionId: 's2', now: new Date('2026-07-03T22:00:00Z') },
    );
    expect(second.duplicate).toBe(true);
    expect(second.existingSessionId).toBe('s1');
    expect(second.existingIssueUrl).toBe('https://github.com/o/r/issues/42');
  });

  it('treats repeated triggers past the window as fresh (not duplicate)', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store, 60);
    await dedup.resolve(
      { sourceType: 'wecom', externalId: 'm1', content: 'help' },
      { sessionId: 's1', now: new Date('2026-07-03T10:00:00Z') },
    );
    const later = await dedup.resolve(
      { sourceType: 'wecom', externalId: 'm1', content: 'help' },
      { sessionId: 's2', now: new Date('2026-07-03T12:00:00Z') },
    );
    expect(later.duplicate).toBe(false);
    expect(later.dedupKey).toContain('wecom|m1|');
  });

  it('different external_id (even with same content) does NOT dedup', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store);
    const a = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm1', content: 'help' },
      { sessionId: 's1' },
    );
    const b = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm2', content: 'help' },
      { sessionId: 's2' },
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
    expect(a.dedupKey).not.toBe(b.dedupKey);
  });

  it('different source_type (same external_id, same content) does NOT dedup', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store);
    const a = await dedup.resolve(
      { sourceType: 'lark', externalId: 'm1', content: 'help' },
      { sessionId: 's1' },
    );
    const b = await dedup.resolve(
      { sourceType: 'wecom', externalId: 'm1', content: 'help' },
      { sessionId: 's2' },
    );
    expect(a.duplicate).toBe(false);
    expect(b.duplicate).toBe(false);
  });

  it('concurrent identical claims serialize to one winner', async () => {
    const store = new InMemoryDedupStore();
    const dedup = new Deduplicator(store);
    const results = await Promise.all(
      ['s1', 's2', 's3'].map((sid) =>
        dedup.resolve(
          { sourceType: 'lark', externalId: 'm1', content: 'help' },
          { sessionId: sid },
        ),
      ),
    );
    const winners = results.filter((r) => !r.duplicate);
    const duplicates = results.filter((r) => r.duplicate);
    expect(winners.length).toBe(1);
    expect(duplicates.length).toBe(2);
  });
});

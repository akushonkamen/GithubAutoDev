/**
 * Issue snapshot + material change regression — T-M2-003, spec §9.4 / §9.5.
 */

import { describe, expect, it } from 'vitest';
import { canonicalIssueBody, detectMaterialChange, isStale, snapshotIssue } from '../snapshot.js';

describe('snapshotIssue (T-M2-003)', () => {
  it('hashes title + body into a stable sha256', () => {
    const a = snapshotIssue({ title: 'Bug', body: 'steps to reproduce' });
    const b = snapshotIssue({ title: 'Bug', body: 'steps to reproduce' });
    expect(a.sha).toBe(b.sha);
    expect(a.sha).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('changes sha when title changes', () => {
    const a = snapshotIssue({ title: 'Bug', body: 'x' });
    const b = snapshotIssue({ title: 'Bug!', body: 'x' });
    expect(a.sha).not.toBe(b.sha);
  });

  it('changes sha when body changes', () => {
    const a = snapshotIssue({ title: 'Bug', body: 'one' });
    const b = snapshotIssue({ title: 'Bug', body: 'two' });
    expect(a.sha).not.toBe(b.sha);
  });

  it('ignores cosmetic trailing whitespace', () => {
    const a = snapshotIssue({ title: 'Bug', body: 'line one   \n\n\nline two' });
    const b = snapshotIssue({ title: 'Bug', body: 'line one\n\nline two' });
    expect(a.sha).toBe(b.sha);
  });

  it('treats null body and empty body as the same canonical form', () => {
    const a = snapshotIssue({ title: 'Bug', body: null });
    const b = snapshotIssue({ title: 'Bug', body: '' });
    expect(a.sha).toBe(b.sha);
  });
});

describe('detectMaterialChange (T-M2-003)', () => {
  it('reports material=true when prev is null (first snapshot)', () => {
    const next = snapshotIssue({ title: 'Bug', body: 'x' });
    const r = detectMaterialChange(null, next);
    expect(r.material).toBe(true);
    expect(r.prevSha).toBeNull();
    expect(r.nextSha).toBe(next.sha);
  });

  it('reports material=false for identical snapshots', () => {
    const snap = snapshotIssue({ title: 'Bug', body: 'x' });
    const r = detectMaterialChange(snap, snap);
    expect(r.material).toBe(false);
  });

  it('reports material=true when body changes', () => {
    const prev = snapshotIssue({ title: 'Bug', body: 'x' });
    const next = snapshotIssue({ title: 'Bug', body: 'y' });
    const r = detectMaterialChange(prev, next);
    expect(r.material).toBe(true);
    expect(r.prevSha).toBe(prev.sha);
    expect(r.nextSha).toBe(next.sha);
  });

  it('label-only changes do not appear in the snapshot (no generation bump)', () => {
    // Simulate label projection change: title and body unchanged, so
    // detectMaterialChange must report material=false.
    const prev = snapshotIssue({ title: 'Bug', body: 'steps' });
    const next = snapshotIssue({ title: 'Bug', body: 'steps' });
    expect(detectMaterialChange(prev, next).material).toBe(false);
  });
});

describe('canonicalIssueBody', () => {
  it('returns empty string for null', () => {
    expect(canonicalIssueBody(null)).toBe('');
  });

  it('collapses 3+ newlines into 2', () => {
    expect(canonicalIssueBody('a\n\n\n\nb')).toBe('a\n\nb');
  });

  it('trims trailing whitespace per line', () => {
    expect(canonicalIssueBody('a   \nb \n')).toBe('a\nb');
  });
});

describe('isStale', () => {
  it('returns false when event generation is null', () => {
    expect(isStale(3, null)).toBe(false);
  });

  it('returns false when event generation >= current', () => {
    expect(isStale(3, 3)).toBe(false);
    expect(isStale(3, 4)).toBe(false);
  });

  it('returns true when event generation < current', () => {
    expect(isStale(3, 2)).toBe(true);
  });
});

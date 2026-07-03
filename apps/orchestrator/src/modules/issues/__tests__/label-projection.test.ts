/**
 * Label projection — T-M3-003, spec §14.1.
 *
 * Locks the contracts:
 *   - Internal state change → minimal add/remove label set.
 *   - External edit to cgao:* labels → ReconciliationSignal only,
 *     never direct state mutation.
 *   - Non-cgao labels are always left alone.
 */

import { describe, expect, it } from 'vitest';
import { LabelProjectionService } from '../label-projection.js';

describe('LabelProjectionService.apply (T-M3-003)', () => {
  const svc = new LabelProjectionService();

  it('adds the desired cgao:kind + cgao:status labels when none exist', () => {
    const p = svc.apply([], { category: 'bug', status: 'ready' });
    expect(p.add).toContain('cgao:kind/bug');
    expect(p.add).toContain('cgao:status/ready');
    expect(p.remove).toEqual([]);
  });

  it('removes stale cgao labels when the authoritative state changes', () => {
    const existing = ['cgao:kind/feature', 'cgao:status/needs_info', 'priority:high'];
    const p = svc.apply(existing, { category: 'bug', status: 'ready' });
    expect(p.add).toContain('cgao:kind/bug');
    expect(p.add).toContain('cgao:status/ready');
    expect(p.remove).toContain('cgao:kind/feature');
    expect(p.remove).toContain('cgao:status/needs_info');
    // Non-cgao labels are never touched.
    expect(p.remove).not.toContain('priority:high');
    expect(p.add).not.toContain('priority:high');
  });

  it('is a no-op when authoritative labels are already present', () => {
    const existing = ['cgao:kind/bug', 'cgao:status/ready'];
    const p = svc.apply(existing, { category: 'bug', status: 'ready' });
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
  });

  it('matches case-insensitively', () => {
    const existing = ['CGAO:KIND/Bug', 'Cgao:Status/Ready'];
    const p = svc.apply(existing, { category: 'bug', status: 'ready' });
    expect(p.add).toEqual([]);
    expect(p.remove).toEqual([]);
  });
});

describe('LabelProjectionService.formatLabels (T-M3-003)', () => {
  const svc = new LabelProjectionService();

  it('formats the kind and status pair', () => {
    expect(svc.formatLabels({ category: 'bug', status: 'ready' })).toEqual({
      kind: 'cgao:kind/bug',
      status: 'cgao:status/ready',
    });
  });
});

describe('LabelProjectionService.detectExternalEdit (T-M3-003)', () => {
  const svc = new LabelProjectionService();
  const authoritative = { category: 'bug' as const, status: 'ready' as const };

  it('returns an "added" signal when a human adds a cgao:status label', () => {
    const signals = svc.detectExternalEdit({
      before: [],
      after: ['cgao:status/in_progress'],
      authoritative,
      actorLogin: 'alice',
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.surface).toBe('status');
    expect(signals[0]?.action).toBe('added');
    expect(signals[0]?.attemptedValue).toBe('in_progress');
    expect(signals[0]?.actorLogin).toBe('alice');
    expect(signals[0]?.authoritative).toEqual(authoritative);
  });

  it('returns a "removed" signal when a human removes the cgao:kind label', () => {
    const signals = svc.detectExternalEdit({
      before: ['cgao:kind/bug', 'cgao:status/ready'],
      after: ['cgao:status/ready'],
      authoritative,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.surface).toBe('kind');
    expect(signals[0]?.action).toBe('removed');
  });

  it('does NOT emit a signal for non-cgao label edits', () => {
    const signals = svc.detectExternalEdit({
      before: ['priority:high'],
      after: ['priority:low'],
      authoritative,
    });
    expect(signals).toEqual([]);
  });

  it('does NOT emit a signal when cgao labels match the authoritative state', () => {
    const signals = svc.detectExternalEdit({
      before: ['cgao:kind/bug', 'cgao:status/ready'],
      after: ['cgao:kind/bug', 'cgao:status/ready'],
      authoritative,
    });
    expect(signals).toEqual([]);
  });

  it('emits signals for both add AND remove when a human swaps cgao labels', () => {
    const signals = svc.detectExternalEdit({
      before: ['cgao:status/ready'],
      after: ['cgao:status/in_progress'],
      authoritative,
    });
    expect(signals).toHaveLength(2);
    const actions = signals.map((s) => `${s.action}:${s.attemptedValue}`).sort();
    expect(actions).toEqual(['added:in_progress', 'removed:ready']);
  });

  it('carries the source comment id for audit', () => {
    const signals = svc.detectExternalEdit({
      before: [],
      after: ['cgao:status/approved'],
      authoritative,
      sourceCommentId: 42,
    });
    expect(signals[0]?.sourceCommentId).toBe(42);
  });
});

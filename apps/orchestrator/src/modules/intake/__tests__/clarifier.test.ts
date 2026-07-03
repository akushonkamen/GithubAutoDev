/**
 * Clarifier state machine — T-INTAKE-005, spec §12.0 Tier 3.
 */

import { describe, expect, it } from 'vitest';
import {
  type ClarifierConfig,
  DEFAULT_CLARIFIER_CONFIG,
  type IntakeSession,
  advance,
  dropForInactivity,
  freshSession,
  isInactive,
} from '../clarifier.js';

const cfg: ClarifierConfig = {
  ...DEFAULT_CLARIFIER_CONFIG,
  confidenceThreshold: 0.7,
  maxRounds: 5,
};

describe('freshSession', () => {
  it('starts in pending with round 0', () => {
    const s = freshSession({ id: 's1' });
    expect(s.state).toBe('pending');
    expect(s.round).toBe(0);
    expect(s.lastConfidence).toBe(0);
  });
});

describe('advance (T-INTAKE-005)', () => {
  it('transitions pending → ready when confidence ≥ threshold', () => {
    const s = freshSession({ id: 's1' });
    const r = advance(s, { message: 'deploy broken at 3am', confidence: 0.85 }, cfg);
    expect(r.session.state).toBe('ready');
    expect(r.done).toBe(true);
    expect(r.nextQuestion).toBeNull();
    expect(r.session.lastConfidence).toBe(0.85);
  });

  it('transitions pending → confirming when confidence < threshold and asks Q1', () => {
    const s = freshSession({ id: 's1' });
    const r = advance(s, { message: 'something is off', confidence: 0.3 }, cfg);
    expect(r.session.state).toBe('confirming');
    expect(r.session.round).toBe(1);
    expect(r.nextQuestion).toContain('Clarifier round 1');
    expect(r.done).toBe(false);
  });

  it('drops after maxRounds rounds without crossing threshold', () => {
    let s = freshSession({ id: 's1' });
    for (let i = 1; i <= cfg.maxRounds; i++) {
      const r = advance(s, { message: `round ${i}`, confidence: 0.3 }, cfg);
      expect(r.session.state).toBe('confirming');
      expect(r.session.round).toBe(i);
      s = r.session;
    }
    // One more turn after maxRounds → drop.
    const final = advance(s, { message: 'one more', confidence: 0.3 }, cfg);
    expect(final.session.state).toBe('dropped');
    expect(final.session.dropReason).toBe('max_rounds');
    expect(final.done).toBe(true);
  });

  it('bypasses clarifier when explicitTriggered=true', () => {
    const s = freshSession({ id: 's1' });
    const r = advance(s, { message: 'help', confidence: 0.0, explicitTriggered: true }, cfg);
    expect(r.session.state).toBe('ready');
    expect(r.session.lastConfidence).toBe(1);
    expect(r.done).toBe(true);
  });

  it('drops immediately when user abandons', () => {
    const s = freshSession({ id: 's1' });
    const r = advance(s, { message: 'never mind', confidence: 0.0, userAbandoned: true }, cfg);
    expect(r.session.state).toBe('dropped');
    expect(r.session.dropReason).toBe('user_abandoned');
  });

  it('terminal states are sticky (ready stays ready)', () => {
    const ready: IntakeSession = {
      ...freshSession({ id: 's1' }),
      state: 'ready',
      lastConfidence: 0.9,
    };
    const r = advance(ready, { message: 'whatever', confidence: 0.2 }, cfg);
    expect(r.session.state).toBe('ready');
    expect(r.done).toBe(true);
  });

  it('terminal states are sticky (dropped stays dropped)', () => {
    const dropped: IntakeSession = {
      ...freshSession({ id: 's1' }),
      state: 'dropped',
      dropReason: 'user_abandoned',
    };
    const r = advance(dropped, { message: 'ok', confidence: 0.9 }, cfg);
    expect(r.session.state).toBe('dropped');
  });
});

describe('isInactive / dropForInactivity', () => {
  const cfg24h = { ...cfg, inactivityTimeoutMs: 24 * 60 * 60 * 1000 };

  it('marks confirming sessions past 24h as inactive', () => {
    const s: IntakeSession = {
      ...freshSession({ id: 's1', now: new Date('2026-07-01T00:00:00Z') }),
      state: 'confirming',
    };
    expect(isInactive(s, new Date('2026-07-02T00:00:01Z'), cfg24h)).toBe(true);
    expect(isInactive(s, new Date('2026-07-01T23:00:00Z'), cfg24h)).toBe(false);
  });

  it('does not mark terminal sessions inactive', () => {
    const ready: IntakeSession = {
      ...freshSession({ id: 's1', now: new Date('2026-07-01T00:00:00Z') }),
      state: 'ready',
    };
    expect(isInactive(ready, new Date('2026-08-01T00:00:00Z'), cfg24h)).toBe(false);
  });

  it('dropForInactivity transitions to dropped with reason=inactivity_timeout', () => {
    const s: IntakeSession = {
      ...freshSession({ id: 's1', now: new Date('2026-07-01T00:00:00Z') }),
      state: 'confirming',
    };
    const dropped = dropForInactivity(s, new Date('2026-07-02T00:00:01Z'));
    expect(dropped.state).toBe('dropped');
    expect(dropped.dropReason).toBe('inactivity_timeout');
  });

  it('dropForInactivity leaves terminal sessions untouched', () => {
    const ready: IntakeSession = { ...freshSession({ id: 's1' }), state: 'ready' };
    expect(dropForInactivity(ready, new Date())).toEqual(ready);
  });
});

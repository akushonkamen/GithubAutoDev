/**
 * Replay regression — attack-scenarios/webhook-replay.md §4.1, spec §15.
 *
 * The dedup triple `source | type | external_id | content_hash`
 * must be stable for identical payloads, and must change for any
 * mutation. T-M1-002 will enforce the 24h window at the DB layer;
 * here we lock the key derivation so future code can't accidentally
 * weaken it.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildDedupKey, replayRequest } from '../index.js';

const BASE = {
  source: 'github' as const,
  type: 'pull_request',
  externalId: 'd0e1f2a3-b4c5-6789-0abc-def123456789',
  body: JSON.stringify({ action: 'closed', number: 42 }),
};

describe('webhook replay / dedup key', () => {
  it('returns the same key for 10 replays of the same payload', () => {
    const captures = replayRequest({ headers: {}, body: BASE.body }, 10);
    const keys = new Set(captures.map((r) => buildDedupKey({ ...BASE, body: r.body })));
    expect(keys.size).toBe(1);
  });

  it('changes when the body is mutated by one byte', () => {
    const k1 = buildDedupKey(BASE);
    const k2 = buildDedupKey({ ...BASE, body: BASE.body.replace('42', '43') });
    expect(k1).not.toBe(k2);
  });

  it('embeds a sha256 content prefix matching the body', () => {
    const key = buildDedupKey(BASE);
    const expectedHash = createHash('sha256').update(BASE.body).digest('hex').slice(0, 16);
    expect(key.endsWith(expectedHash)).toBe(true);
  });

  it('changes when external_id changes (different deliveries)', () => {
    const k1 = buildDedupKey(BASE);
    const k2 = buildDedupKey({ ...BASE, externalId: '11111111-2222-3333-4444-555555555555' });
    expect(k1).not.toBe(k2);
  });
});

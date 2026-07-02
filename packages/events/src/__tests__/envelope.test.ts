/**
 * Envelope schema smoke test — ensures topic regex + topic registry hold.
 * Lands as part of T-M0-005 (event spec).
 */
import { describe, expect, it } from 'vitest';
import { CGAO_TOPICS, cgaoEventEnvelopeSchema } from '../envelope.js';

describe('CGAO event envelope schema (T-M0-005)', () => {
  it('topic registry is non-empty and stable', () => {
    expect(CGAO_TOPICS.length).toBeGreaterThan(8);
    // Critical invariant: triage_requested is NOT a topic
    expect(CGAO_TOPICS).not.toContain('issue.triage_requested');
  });

  it('rejects malformed topic names', () => {
    expect(() =>
      cgaoEventEnvelopeSchema.parse({
        id: '00000000-0000-4000-8000-000000000000',
        source: 'repo:o/r',
        type: 'UPPER.CASE',
        time: '2026-07-03T00:00:00.000Z',
        subject: 'issue#1',
        datacontenttype: 'application/json',
        data: {},
        trace: { repo: 'o/r', run_id: null, prev_hash: null },
        dedup_key: 'k',
      }),
    ).toThrow();
  });

  it('accepts a well-formed intake webhook event', () => {
    const env = cgaoEventEnvelopeSchema.parse({
      id: '11111111-1111-4111-8111-111111111111',
      source: 'repo:o/r',
      type: 'intake.webhook.lark',
      time: '2026-07-03T00:00:00.000Z',
      subject: 'intake#session-1',
      datacontenttype: 'application/json',
      data: { msg_id: 'om_abc', content: { text: 'bug' } },
      trace: { repo: 'o/r', run_id: null, prev_hash: null },
      dedup_key: 'lark|om_abc|sha256:xyz',
    });
    expect(env.type).toBe('intake.webhook.lark');
  });
});

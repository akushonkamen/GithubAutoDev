/**
 * EventBus regression — spec §8, §10, T-M1-005.
 *
 * Locks the retry + DLQ contract before the NATS adapter lands.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_RETRY_POLICY, DLQ_TOPIC, InMemoryEventBus } from '../index.js';

function fastPolicy() {
  return { ...DEFAULT_RETRY_POLICY, baseDelayMs: 1, maxDelayMs: 5, maxAttempts: 3 };
}

describe('InMemoryEventBus', () => {
  it('delivers a published message to all subscribers', async () => {
    const bus = new InMemoryEventBus({ retry: fastPolicy() });
    const seen: string[] = [];
    bus.subscribe('issue.opened', (m) => {
      seen.push(m.id);
    });
    await bus.publish({
      topic: 'issue.opened',
      payload: { n: 1 },
      headers: {},
      traceId: 't1',
    });
    expect(seen).toHaveLength(1);
  });

  it('retries with exponential backoff and recovers', async () => {
    const bus = new InMemoryEventBus({ retry: fastPolicy() });
    let calls = 0;
    bus.subscribe('topic.a', () => {
      calls++;
      if (calls < 3) throw new Error('transient');
    });
    await bus.publish({ topic: 'topic.a', payload: {}, headers: {}, traceId: null });
    expect(calls).toBe(3);
  });

  it('routes to the DLQ topic after exceeding max attempts', async () => {
    const bus = new InMemoryEventBus({ retry: fastPolicy() });
    const dlq: string[] = [];
    bus.subscribe(DLQ_TOPIC, (m) => {
      dlq.push(m.headers['x-original-id'] ?? 'unknown');
    });
    bus.subscribe('topic.fail', () => {
      throw new Error('always fails');
    });
    const failures: string[] = [];
    bus.onDeliveryFailure((e) => failures.push(e.topic));
    await bus.publish({
      topic: 'topic.fail',
      payload: { x: 1 },
      headers: {},
      traceId: null,
      id: 'msg-1',
    });
    expect(dlq).toContain('msg-1');
    expect(failures).toContain('topic.fail');
  });

  it('isolates topic queues (cross-topic delivery never happens)', async () => {
    const bus = new InMemoryEventBus({ retry: fastPolicy() });
    const a: unknown[] = [];
    const b: unknown[] = [];
    bus.subscribe('topic.a', (m) => {
      a.push(m.payload);
    });
    bus.subscribe('topic.b', (m) => {
      b.push(m.payload);
    });
    await bus.publish({ topic: 'topic.a', payload: 'A1', headers: {}, traceId: null });
    await bus.publish({ topic: 'topic.b', payload: 'B1', headers: {}, traceId: null });
    expect(a).toEqual(['A1']);
    expect(b).toEqual(['B1']);
  });

  it('supports multiple subscribers per topic', async () => {
    const bus = new InMemoryEventBus({ retry: fastPolicy() });
    let c1 = 0;
    let c2 = 0;
    bus.subscribe('topic.c', () => {
      c1++;
    });
    bus.subscribe('topic.c', () => {
      c2++;
    });
    await bus.publish({ topic: 'topic.c', payload: {}, headers: {}, traceId: null });
    expect(c1).toBe(1);
    expect(c2).toBe(1);
  });
});

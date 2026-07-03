/**
 * T-M10-004 RateLimiter — per-(repo,kind) token bucket for webhooks.
 */

import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../rate-limiter.js';

describe('T-M10-004 RateLimiter', () => {
  it('allows up to capacity and then refuses', () => {
    const t = 1_000;
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 1 }, () => t);
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(true);
    const refused = rl.take('cgao/test', 'webhook');
    expect(refused.allowed).toBe(false);
    expect(refused.remaining).toBe(0);
  });

  it('refills tokens at the configured rate', () => {
    let t = 1_000;
    const rl = new RateLimiter({ capacity: 3, refillPerSecond: 10 }, () => t);
    rl.take('cgao/test', 'webhook');
    rl.take('cgao/test', 'webhook');
    rl.take('cgao/test', 'webhook');
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(false);
    t += 200; // 0.2s -> 2 tokens refilled
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/test', 'webhook').allowed).toBe(false);
  });

  it('isolates buckets per (repo, kind)', () => {
    const rl = new RateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(rl.take('cgao/a', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/a', 'webhook').allowed).toBe(false);
    expect(rl.take('cgao/b', 'webhook').allowed).toBe(true);
    expect(rl.take('cgao/a', 'issue').allowed).toBe(true);
  });
});

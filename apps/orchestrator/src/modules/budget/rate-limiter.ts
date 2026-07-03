/**
 * RateLimiter — T-M10-004, spec §12.11 / §18.
 *
 * Token-bucket per (repo, kind) for webhook throughput. Each (repo, kind)
 * has its own bucket that refills at `refillPerSecond` tokens up to
 * `capacity`. take() removes 1 token; if no tokens are available the
 * call returns { allowed: false }.
 *
 * Decision: simple in-memory token bucket. Sufficient for the
 * orchestrator's startup mode; a Redis-backed limiter lands later
 * without changing this interface.
 */

export interface RateLimiterConfig {
  /** Bucket capacity per (repo, kind). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSecond: number;
}

export interface TakeResult {
  allowed: boolean;
  remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly config: RateLimiterConfig,
    private readonly now: () => number = Date.now,
  ) {}

  take(repo: string, kind: string, n = 1): TakeResult {
    const key = `${repo}|${kind}`;
    const b = this.buckets.get(key) ?? { tokens: this.config.capacity, lastRefill: this.now() };
    this.refill(b);
    if (b.tokens >= n) {
      b.tokens -= n;
      this.buckets.set(key, b);
      return { allowed: true, remaining: b.tokens };
    }
    this.buckets.set(key, b);
    return { allowed: false, remaining: b.tokens };
  }

  private refill(b: Bucket): void {
    const now = this.now();
    const elapsedMs = now - b.lastRefill;
    if (elapsedMs <= 0) return;
    const refill = (elapsedMs / 1000) * this.config.refillPerSecond;
    b.tokens = Math.min(this.config.capacity, b.tokens + refill);
    b.lastRefill = now;
  }

  /** Test helper: get the current token count without refilling. */
  tokensFor(repo: string, kind: string): number {
    return this.buckets.get(`${repo}|${kind}`)?.tokens ?? this.config.capacity;
  }
}

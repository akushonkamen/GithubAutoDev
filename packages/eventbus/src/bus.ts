/**
 * EventBus contract — spec §8, §10, T-M1-005.
 *
 * Implementations:
 *  - InMemoryEventBus (M1, this package)
 *  - NATS adapter (T-M1-005 follow-up; same interface)
 *
 * The DLQ is a normal topic (`dlq`) — consumers (alert router,
 * reconciler) subscribe like any other topic. Producers MUST NOT
 * publish to it directly; only the retry loop does.
 */

import { type DeliveryError, MaxAttemptsExceededError } from './errors.js';

export const DLQ_TOPIC = 'dlq';

export interface BusMessage {
  id: string;
  topic: string;
  payload: unknown;
  headers: Record<string, string>;
  traceId: string | null;
  /** Monotonic ms timestamp. */
  at: number;
}

export type Consumer = (msg: BusMessage) => Promise<void> | void;

export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** Exponential backoff factor. 2 = doubling. */
  factor: number;
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 100,
  maxDelayMs: 5_000,
  factor: 2,
};

export interface EventBus {
  publish(
    msg: Omit<BusMessage, 'id' | 'at'> & Partial<Pick<BusMessage, 'id' | 'at'>>,
  ): Promise<void>;
  subscribe(topic: string, consumer: Consumer): () => void;
  /** Snapshot — used by tests / ops. Production reads via metrics. */
  unread(topic: string): number;
}

/** Pure in-memory bus with retry + DLQ routing. Spec §8, T-M1-005. */
export class InMemoryEventBus implements EventBus {
  private readonly queues = new Map<string, BusMessage[]>();
  private readonly consumers = new Map<string, Set<Consumer>>();
  private readonly retry: RetryPolicy;
  private readonly dlqTopic: string;
  private readonly failListeners = new Set<(e: DeliveryError) => void>();

  constructor(opts: { retry?: RetryPolicy; dlqTopic?: string } = {}) {
    this.retry = opts.retry ?? DEFAULT_RETRY_POLICY;
    this.dlqTopic = opts.dlqTopic ?? DLQ_TOPIC;
  }

  async publish(
    msg: Omit<BusMessage, 'id' | 'at'> & Partial<Pick<BusMessage, 'id' | 'at'>>,
  ): Promise<void> {
    const full: BusMessage = {
      id: msg.id ?? globalThis.crypto.randomUUID(),
      topic: msg.topic,
      payload: msg.payload,
      headers: { ...msg.headers },
      traceId: msg.traceId ?? null,
      at: msg.at ?? Date.now(),
    };
    this.queues.get(full.topic) ?? this.queues.set(full.topic, []);
    this.queues.get(full.topic)?.push(full);
    await this.drain(full.topic);
  }

  subscribe(topic: string, consumer: Consumer): () => void {
    const set = this.consumers.get(topic) ?? new Set<Consumer>();
    set.add(consumer);
    this.consumers.set(topic, set);
    return () => {
      set.delete(consumer);
    };
  }

  unread(topic: string): number {
    return this.queues.get(topic)?.length ?? 0;
  }

  /** Test helper: subscribe to every consumer-side delivery failure. */
  onDeliveryFailure(fn: (e: DeliveryError) => void): () => void {
    this.failListeners.add(fn);
    return () => this.failListeners.delete(fn);
  }

  private async drain(topic: string): Promise<void> {
    const queue = this.queues.get(topic);
    const consumers = this.consumers.get(topic);
    if (!queue || !consumers) return;
    while (queue.length > 0 && consumers.size > 0) {
      const msg = queue.shift();
      if (!msg) break;
      for (const consumer of consumers) {
        await this.deliverWithRetry(topic, consumer, msg);
      }
    }
  }

  private async deliverWithRetry(
    topic: string,
    consumer: Consumer,
    msg: BusMessage,
  ): Promise<void> {
    let attempt = 0;
    let lastCause: unknown = null;
    while (attempt < this.retry.maxAttempts) {
      attempt++;
      try {
        await consumer(msg);
        return;
      } catch (cause) {
        lastCause = cause;
        if (attempt >= this.retry.maxAttempts) break;
        const delay = Math.min(
          this.retry.baseDelayMs * this.retry.factor ** (attempt - 1),
          this.retry.maxDelayMs,
        );
        await sleep(delay);
      }
    }
    const err = new MaxAttemptsExceededError({
      topic,
      messageId: msg.id,
      attempt,
      cause: lastCause,
    });
    for (const fn of this.failListeners) {
      fn(err.delivery);
    }
    await this.publish({
      topic: this.dlqTopic,
      payload: { reason: 'max_attempts', original: msg, lastCause: String(lastCause) },
      headers: { 'x-origin-topic': topic, 'x-original-id': msg.id },
      traceId: msg.traceId,
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

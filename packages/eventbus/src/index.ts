/**
 * @cgao/eventbus — EventBus abstraction (T-M1-005).
 *
 * Spec §8 / §10. Producers publish CloudEvents; consumers subscribe
 * to topics. Failures retry with exponential backoff up to a max
 * attempt count, after which the message lands on the DLQ topic.
 *
 * M1 ships the in-memory implementation + the contract types. The
 * NATS adapter (T-M1-005 completion) plugs the same interface into
 * a real broker.
 */

export {
  type BusMessage,
  type Consumer,
  type EventBus,
  type RetryPolicy,
  DEFAULT_RETRY_POLICY,
  InMemoryEventBus,
  DLQ_TOPIC,
} from './bus.js';
export {
  type DeliveryError,
  MaxAttemptsExceededError,
} from './errors.js';

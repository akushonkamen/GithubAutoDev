export interface DeliveryError {
  topic: string;
  messageId: string;
  attempt: number;
  cause: unknown;
}

/** Thrown internally when a message exhausts its retry budget. */
export class MaxAttemptsExceededError extends Error {
  readonly delivery: DeliveryError;
  constructor(delivery: DeliveryError) {
    super(
      `message ${delivery.messageId} on ${delivery.topic} exceeded retry budget after ${delivery.attempt} attempts`,
    );
    this.name = 'MaxAttemptsExceededError';
    this.delivery = delivery;
  }
}

/**
 * Webhook replay builder — attack-scenarios/webhook-replay.md §4.
 *
 * Constructs N identical replay requests from one captured delivery.
 * Tests use this to drive the dedup middleware (T-M1-002) and confirm
 * `DEDUP_REPLAY` fires for the second onward within the 24h window.
 */

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
}

export function replayRequest(src: WebhookRequest, count: number): WebhookRequest[] {
  if (count < 1) throw new Error('count must be >= 1');
  return Array.from({ length: count }, () => ({
    headers: { ...src.headers },
    body: src.body,
  }));
}

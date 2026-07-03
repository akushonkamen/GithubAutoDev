/**
 * GitHub webhook route — T-M1-001 / T-M1-002 / T-M1-003 / T-M1-004.
 *
 * Pipeline:
 *   1. Signature verification (HMAC-SHA256, constant-time)
 *   2. Dedup check (delivery id + content hash within 24h)
 *   3. CloudEvent mapping (issues / issue_comment / pull_request / workflow_run)
 *   4. Origin suppression (skip self-echo from CGAO mutations)
 *   5. Raw payload artifact writer hook (forensic chain)
 *   6. EventBus publish (consumers wire in M3+)
 *
 * Returns 200 even on dedup hits so GitHub doesn't retry. The DEDUP_REPLAY
 * and AUTH_SIGNATURE_INVALID error codes are emitted via the bus's
 * observability hook, not the HTTP response body.
 */

import type { ArtifactStore } from '@cgao/artifacts';
import type { EventBus } from '@cgao/eventbus';
import { verifyGithubSignature } from '@cgao/github';
import {
  type CloudEventEnvelope,
  UnsupportedEventTypeError,
  mapGithubEvent,
} from '@cgao/github-events';
import type { Context } from 'hono';
import { type DedupStore, contentHashOf } from './dedup-store.js';
import type { SuppressionStore } from './suppression-store.js';

export interface WebhookDeps {
  /** Webhook secret OR a function returning it (env is read per-request). */
  secret: string | (() => string);
  bus: EventBus;
  dedup: DedupStore;
  suppression: SuppressionStore;
  artifacts: ArtifactStore | null;
  /** GitHub login of the CGAO bot, for origin suppression. */
  botLogin: string | (() => string);
  /** Test seam: now() override. */
  now?: () => Date;
}

function resolveSecret(deps: WebhookDeps): string {
  return typeof deps.secret === 'function' ? deps.secret() : deps.secret;
}

function resolveBotLogin(deps: WebhookDeps): string {
  return typeof deps.botLogin === 'function' ? deps.botLogin() : deps.botLogin;
}

export interface WebhookOutcome {
  status: number;
  kind: 'accepted' | 'deduped' | 'rejected' | 'unsupported';
  deliveryId: string | null;
  eventType: string | null;
}

const DEDUP_TOPIC = 'webhook.github.deduped';
const REJECT_TOPIC = 'webhook.github.rejected';

export async function handleGithubWebhook(c: Context, deps: WebhookDeps): Promise<Response> {
  const body = await c.req.text();
  const sig = c.req.header('x-hub-signature-256') ?? '';
  const event = c.req.header('x-github-event') ?? '';
  const delivery = c.req.header('x-github-delivery') ?? '';

  // 1. Signature verification (C-IM-03, AS-01)
  if (!sig || !verifyGithubSignature(body, sig, resolveSecret(deps))) {
    await deps.bus.publish({
      topic: REJECT_TOPIC,
      payload: { reason: 'AUTH_SIGNATURE_INVALID', delivery },
      headers: { 'x-cgao-error': 'AUTH_SIGNATURE_INVALID' },
      traceId: delivery ?? null,
    });
    return c.json(outcome('rejected', null, event), 401);
  }

  // 2. Dedup (C-IM-06, AS-02)
  const chash = contentHashOf(body);
  const prior = await deps.dedup.lookup(delivery);
  if (prior && prior.contentHash === chash) {
    await deps.bus.publish({
      topic: DEDUP_TOPIC,
      payload: { delivery, contentHash: chash },
      headers: { 'x-cgao-error': 'DEDUP_REPLAY' },
      traceId: delivery,
    });
    return c.json(outcome('deduped', delivery, event), 200);
  }
  await deps.dedup.remember(delivery, chash);

  // 3. CloudEvent mapping
  let envelope: CloudEventEnvelope;
  try {
    const raw = JSON.parse(body) as unknown;
    envelope = mapGithubEvent(
      {
        'x-github-event': event,
        'x-github-delivery': delivery,
        'x-hub-signature-256': sig,
      },
      raw,
      deps.now ? deps.now() : new Date(),
    );
  } catch (err) {
    if (err instanceof UnsupportedEventTypeError) {
      await deps.bus.publish({
        topic: REJECT_TOPIC,
        payload: {
          reason: 'UNSUPPORTED_EVENT',
          delivery,
          eventType: err.eventType,
          action: err.action,
        },
        headers: { 'x-cgao-error': 'UNSUPPORTED_EVENT' },
        traceId: delivery,
      });
      return c.json(outcome('unsupported', delivery, event), 202);
    }
    throw err;
  }

  // 4. Origin suppression (AS-MOD, T-M1-004)
  const actor = readActor(envelope.data);
  const botLogin = resolveBotLogin(deps);
  if (actor && actor === botLogin) {
    const matched = await deps.suppression.match({
      actor,
      eventType: envelope.type,
      subject: envelope.subject,
      contentHash: chash,
    });
    if (matched) {
      envelope = { ...envelope, origin: 'cgao' as const };
      await deps.bus.publish({
        topic: 'webhook.github.observed',
        payload: envelope,
        headers: { 'x-cgao-origin': 'cgao' },
        traceId: envelope.traceId,
      });
      return c.json(outcome('accepted', delivery, envelope.type), 200);
    }
  }

  // 5. Raw payload artifact (forensic chain — spec §6.4 / §19)
  if (deps.artifacts) {
    await deps.artifacts.write({
      kind: 'raw_payload',
      key: `sha256:${chash}`,
      content: body,
      repo: envelope.repo,
      runId: null,
      createdAt: envelope.time,
    });
  }

  // 6. Publish to bus
  await deps.bus.publish({
    topic: `webhook.github.${envelope.type}`,
    payload: envelope,
    headers: { 'x-cgao-origin': envelope.origin },
    traceId: envelope.traceId,
  });

  return c.json(outcome('accepted', delivery, envelope.type), 200);
}

function outcome(
  kind: WebhookOutcome['kind'],
  delivery: string | null,
  event: string | null,
): WebhookOutcome {
  return {
    status: kind === 'rejected' ? 401 : kind === 'unsupported' ? 202 : 200,
    kind,
    deliveryId: delivery,
    eventType: event,
  };
}

function readActor(data: unknown): string | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;
  // Each event type nests a different actor location.
  if (d.comment && typeof d.comment === 'object') {
    const user = (d.comment as { user?: { login?: string } }).user;
    return user?.login ?? null;
  }
  if (d.sender && typeof d.sender === 'object') {
    return (d.sender as { login?: string }).login ?? null;
  }
  return null;
}

/**
 * Webhook pipeline regression — T-M1-001 / T-M1-002 / T-M1-004.
 *
 * Drives the full /github/webhook route with the in-memory bus,
 * dedup store, and suppression store. Locks:
 *   - valid signature → accepted, business event published
 *   - replay within 24h → 200 but no business event (DEDUP topic only)
 *   - missing/wrong signature → 401, AUTH_SIGNATURE_INVALID published
 *   - unsupported event → 202, UNSUPPORTED_EVENT published
 *   - self-echo from CGAO bot → observed topic, not the business topic
 */

import { createHash, createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import app, { __internals } from '../server.js';

const SECRET = 'correct horse battery staple';

function sign(body: string): string {
  return `sha256=${createHmac('sha256', SECRET).update(body).digest('hex')}`;
}

async function postWebhook(opts: {
  event: string;
  delivery: string;
  body: unknown;
  sig?: string;
}) {
  const body = JSON.stringify(opts.body);
  const headers: Record<string, string> = {
    'x-github-event': opts.event,
    'x-github-delivery': opts.delivery,
    'x-hub-signature-256': opts.sig ?? sign(body),
  };
  // Override the webhook secret for tests via env is racy; instead hit
  // the handler logic by importing server.js with the real default.
  // The default dev secret is 'dev-secret' — use that here.
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  return app.request('http://localhost/github/webhook', {
    method: 'POST',
    headers,
    body,
  });
}

describe('POST /github/webhook', () => {
  beforeEach(() => {
    process.env.GITHUB_WEBHOOK_SECRET = SECRET;
    __internals.__reset();
  });

  it('rejects requests with no signature header (AUTH_SIGNATURE_INVALID)', async () => {
    const res = await app.request('http://localhost/github/webhook', {
      method: 'POST',
      headers: {
        'x-github-event': 'issues',
        'x-github-delivery': '11111111-1111-1111-1111-111111111111',
      },
      body: '{}',
    });
    expect(res.status).toBe(401);
    const json = (await res.json()) as { kind: string };
    expect(json.kind).toBe('rejected');
  });

  it('rejects requests with a wrong-secret signature', async () => {
    const res = await postWebhook({
      event: 'issues',
      delivery: '22222222-2222-2222-2222-222222222222',
      body: { action: 'opened' },
      sig: 'sha256=deadbeef',
    });
    expect(res.status).toBe(401);
  });

  it('accepts a well-signed issues.opened and returns accepted', async () => {
    const res = await postWebhook({
      event: 'issues',
      delivery: '33333333-3333-3333-3333-333333333333',
      body: {
        action: 'opened',
        issue: {
          number: 1,
          title: 't',
          body: null,
          html_url: 'https://github.com/cgao/test/issues/1',
        },
        repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
      },
    });
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; eventType: string };
    expect(json.kind).toBe('accepted');
    expect(json.eventType).toBe('issues.opened');
  });

  it('deduplicates identical deliveries within the 24h window', async () => {
    const delivery = '44444444-4444-4444-4444-444444444444';
    const body = {
      action: 'opened',
      issue: {
        number: 2,
        title: 'x',
        body: null,
        html_url: 'https://github.com/cgao/test/issues/2',
      },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    };
    const r1 = await postWebhook({ event: 'issues', delivery, body });
    const r2 = await postWebhook({ event: 'issues', delivery, body });
    expect(((await r1.json()) as { kind: string }).kind).toBe('accepted');
    expect(((await r2.json()) as { kind: string }).kind).toBe('deduped');
  });

  it('returns 202 for unsupported event types', async () => {
    const res = await postWebhook({
      event: 'foo_bar',
      delivery: '55555555-5555-5555-5555-555555555555',
      body: {},
    });
    expect(res.status).toBe(202);
  });

  it('T-M1-002: 10 replays of the same delivery produce exactly 1 business event', async () => {
    const delivery = '66666666-6666-6666-6666-666666666666';
    const body = {
      action: 'opened',
      issue: {
        number: 99,
        title: 'replay test',
        body: null,
        html_url: 'https://github.com/cgao/test/issues/99',
      },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    };
    const accepted: string[] = [];
    const deduped: string[] = [];
    const unsubAccepted = __internals.bus.subscribe('webhook.github.issues.opened', (m) => {
      accepted.push(m.id);
    });
    const unsubDedup = __internals.bus.subscribe('webhook.github.deduped', (m) => {
      deduped.push(m.id);
    });

    try {
      for (let i = 0; i < 10; i++) {
        await postWebhook({ event: 'issues', delivery, body });
      }
    } finally {
      unsubAccepted();
      unsubDedup();
    }
    expect(accepted).toHaveLength(1);
    expect(deduped).toHaveLength(9);
  });

  it('T-M1-004/006: self-echo from CGAO bot routes to observed, not the business topic', async () => {
    process.env.CGAO_BOT_LOGIN = 'cgao-bot[bot]';
    const delivery = '77777777-7777-7777-7777-777777777777';
    const issueBody = '["cgao:plan-ready"] <!-- cgao:status-comment-marker abc -->';
    const webhookBody = {
      action: 'created',
      comment: {
        id: 1,
        body: issueBody,
        user: { login: 'cgao-bot[bot]' },
        html_url: 'https://github.com/cgao/test/issues/5#issuecomment-1',
      },
      issue: { number: 5, title: 't', body: null, html_url: 'https://github.com/cgao/test/issues/5' },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    };
    const chash = createHash('sha256').update(JSON.stringify(webhookBody)).digest('hex');
    // Record the mutation the CGAO bot just performed — this is what
    // origin suppression will match against when the webhook echoes back.
    await __internals.suppression.record({
      actor: 'cgao-bot[bot]',
      eventType: 'issue_comment.created',
      subject: 'cgao/test#comment-1',
      contentHash: chash,
    });

    const business: string[] = [];
    const observed: string[] = [];
    const unsubBiz = __internals.bus.subscribe(
      'webhook.github.issue_comment.created',
      (m) => {
        business.push(m.id);
      },
    );
    const unsubObs = __internals.bus.subscribe('webhook.github.observed', (m) => {
      observed.push(m.id);
    });

    try {
      const res = await postWebhook({
        event: 'issue_comment',
        delivery,
        body: webhookBody,
      });
      expect(((await res.json()) as { kind: string }).kind).toBe('accepted');
    } finally {
      unsubBiz();
      unsubObs();
    }
    expect(business).toHaveLength(0);
    expect(observed).toHaveLength(1);
  });
});

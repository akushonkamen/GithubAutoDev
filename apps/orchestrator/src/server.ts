/**
 * Orchestrator HTTP entry.
 *
 * M0: /healthz
 * M1: POST /github/webhook (T-M1-001..004)
 */

import { InMemoryEventBus } from '@cgao/eventbus';
import { Hono } from 'hono';
import { InMemoryDedupStore } from './webhook/dedup-store.js';
import { type WebhookDeps, handleGithubWebhook } from './webhook/github-route.js';
import { InMemorySuppressionStore } from './webhook/suppression-store.js';

const app = new Hono();

app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    service: 'cgao-orchestrator',
    version: '0.0.0',
    milestone: 'M1',
  }),
);

const bus = new InMemoryEventBus();
const dedup = new InMemoryDedupStore();
const suppression = new InMemorySuppressionStore();

const webhookDeps: WebhookDeps = {
  get secret() {
    return process.env.GITHUB_WEBHOOK_SECRET ?? 'dev-secret';
  },
  bus,
  dedup,
  suppression,
  artifacts: null, // T-M2-004 wires the real ArtifactStore
  get botLogin() {
    return process.env.CGAO_BOT_LOGIN ?? 'cgao-bot[bot]';
  },
};

app.post('/github/webhook', (c) => handleGithubWebhook(c, webhookDeps));

const port = Number(process.env.PORT ?? 8787);

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(`[cgao-orchestrator] listening on :${port}`);
  // biome-ignore lint/suspicious/noExplicitAny: Hono serve types vary across versions
  const serve = (app as any).serve ?? (app as any).fetch;
  if (typeof serve === 'function') {
    // biome-ignore lint/suspicious/noExplicitAny: Bun/Deno/Hono variants
    (serve as any).call(app, { port });
  }
}

export default app;

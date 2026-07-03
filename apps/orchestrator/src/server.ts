/**
 * Orchestrator HTTP entry.
 *
 * M0: /healthz
 * M1: POST /github/webhook (T-M1-001..004)
 */

import { InMemoryEventBus } from '@cgao/eventbus';
import { PrometheusRegistry } from '@cgao/observability';
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
const metrics = new PrometheusRegistry();

/**
 * Exported for tests / ops — gives direct access to the bus and stores
 * so regression suites can record mutations, inspect published events,
 * and assert DLQ routing without going through HTTP.
 *
 * `__reset()` clears all three stores' state. Tests MUST call this in
 * `beforeEach` to keep the module-level singletons isolated from
 * earlier test side effects (the InMemoryEventBus does not drain
 * queued messages from prior tests on its own).
 */
export const __internals = {
  bus,
  dedup,
  suppression,
  metrics,
  __reset(): void {
    (bus as unknown as { queues: Map<string, unknown[]> }).queues.clear();
    (bus as unknown as { consumers: Map<string, unknown> }).consumers.clear();
    (dedup as unknown as { records: Map<string, unknown> }).records.clear();
    (suppression as unknown as { records: unknown[] }).records.length = 0;
  },
};

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

app.get('/metrics', () => {
  const body = metrics.format();
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
});

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

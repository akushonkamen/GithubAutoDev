/**
 * Orchestrator HTTP entry.
 *
 * M0: /healthz
 * M1: POST /github/webhook (T-M1-001..004)
 *
 * Plan B Phase 1: production wiring lives in `runtime.ts` — `buildRuntime()`
 * reads `CGAO_RUNTIME` and returns the concrete dedup/suppression/github/
 * artifacts handles. Memory mode (default) keeps everything in-process so
 * `pnpm dev` and the existing test suite work without docker. Real mode
 * wires Postgres + Octokit + (Phase 2) MinIO. The bus stays in-memory in
 * Phase 1 — NATS lands alongside the module-subscription wiring.
 *
 * `__internals` exposes the *same* handles the HTTP entry uses, so tests
 * can inspect mutations without going through HTTP. Memory mode populates
 * it synchronously; real mode populates it after the async boot finishes.
 */

import type { ArtifactStore } from '@cgao/artifacts';
import type { EventBus } from '@cgao/eventbus';
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

/**
 * Boot the runtime. Memory mode is synchronous in spirit (we construct
 * the in-memory stores directly so `__internals` is populated before any
 * HTTP request fires); real mode is async and resolves once Postgres +
 * Octokit are ready.
 *
 * The runtime is captured into `runtimeHandle` and exposed via
 * `__internals` so tests can poke the same instances production uses.
 * The webhook route reads deps lazily via getters so the boot order
 * (memory now / real later) does not matter for route wiring.
 */
const runtimeHandle: {
  bus: EventBus;
  dedup: InMemoryDedupStore;
  suppression: InMemorySuppressionStore;
  metrics: PrometheusRegistry;
} = {
  // Memory-mode placeholders — `bootRuntime()` swaps these out for the
  // real handles (which may be Postgres-backed) once it resolves.
  bus: new InMemoryEventBus(),
  dedup: new InMemoryDedupStore(),
  suppression: new InMemorySuppressionStore(),
  metrics: new PrometheusRegistry(),
};

/**
 * Exported for tests / ops — gives direct access to the bus and stores
 * so regression suites can record mutations, inspect published events,
 * and assert DLQ routing without going through HTTP.
 *
 * `__reset()` clears the in-memory state. Tests MUST call this in
 * `beforeEach` to keep the module-level singletons isolated from
 * earlier test side effects (the InMemoryEventBus does not drain
 * queued messages from prior tests on its own).
 */
export const __internals = {
  get bus(): EventBus {
    return runtimeHandle.bus;
  },
  get dedup(): InMemoryDedupStore {
    return runtimeHandle.dedup;
  },
  get suppression(): InMemorySuppressionStore {
    return runtimeHandle.suppression;
  },
  get metrics(): PrometheusRegistry {
    return runtimeHandle.metrics;
  },
  __reset(): void {
    const bus = runtimeHandle.bus as unknown as { queues: Map<string, unknown[]> };
    const consumers = runtimeHandle.bus as unknown as { consumers: Map<string, unknown> };
    bus.queues.clear();
    consumers.consumers.clear();
    runtimeHandle.dedup.clearForTests();
    runtimeHandle.suppression.clearForTests();
  },
};

// Webhook deps read through getters so they always reflect the current
// runtime handle (memory immediately, real after bootRuntime resolves).
const webhookDeps: WebhookDeps = {
  get secret() {
    return process.env.GITHUB_WEBHOOK_SECRET ?? 'dev-secret';
  },
  get bus() {
    return runtimeHandle.bus;
  },
  get dedup() {
    return runtimeHandle.dedup;
  },
  get suppression() {
    return runtimeHandle.suppression;
  },
  artifacts: null as ArtifactStore | null, // T-M2-004 wires the real ArtifactStore
  get botLogin() {
    return process.env.CGAO_BOT_LOGIN ?? 'cgao-bot[bot]';
  },
};

app.post('/github/webhook', (c) => handleGithubWebhook(c, webhookDeps));

app.get('/metrics', () => {
  const body = runtimeHandle.metrics.format();
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' },
  });
});

/**
 * Boot the runtime and swap the placeholder handles for the real ones.
 * Memory mode is the default and resolves immediately; real mode pulls
 * in Postgres + Octokit lazily so memory-mode boots don't pay the cost.
 *
 * Idempotent — calling it twice is a no-op the second time.
 */
let booted = false;
export async function bootRuntime(): Promise<void> {
  if (booted) return;
  booted = true;
  const { buildRuntime } = await import('./runtime.js');
  const rt = await buildRuntime();
  runtimeHandle.bus = rt.bus;
  runtimeHandle.dedup = rt.dedup;
  runtimeHandle.suppression = rt.suppression;
  runtimeHandle.metrics = rt.metrics;
  webhookDeps.artifacts = rt.artifacts;
}

const port = Number(process.env.PORT ?? 8787);

if (import.meta.url === `file://${process.argv[1]}`) {
  // Boot runtime before serving. Memory mode is synchronous-flavoured but
  // the function still returns a Promise; real mode needs the await.
  bootRuntime()
    .then(() => {
      console.log(`[cgao-orchestrator] listening on :${port}`);
      // biome-ignore lint/suspicious/noExplicitAny: Hono serve types vary across versions
      const serve = (app as any).serve ?? (app as any).fetch;
      if (typeof serve === 'function') {
        // biome-ignore lint/suspicious/noExplicitAny: Bun/Deno/Hono variants
        (serve as any).call(app, { port });
      }
    })
    .catch((err) => {
      console.error('[cgao-orchestrator] boot failed:', err);
      process.exit(1);
    });
}

export default app;

/**
 * Orchestrator HTTP entry. M0 skeleton — real webhook receiver lands in M1.
 *
 * In M0 scope: boot Hono app with a /healthz endpoint so the workspace
 * builds and runs. Actual routes (webhook/github, webhook/intake/lark,
 * webhook/intake/wecom) land in M1.
 */
import { Hono } from 'hono';

const app = new Hono();

app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    service: 'cgao-orchestrator',
    version: '0.0.0',
    milestone: 'M0',
  }),
);

const port = Number(process.env.PORT ?? 8787);

if (import.meta.url === `file://${process.argv[1]}`) {
  // eslint-disable-next-line no-console
  console.log(`[cgao-orchestrator] listening on :${port}`);
  // biome-ignore lint/suspicious/noExplicitAny: Hono serve types vary across versions
  const serve = (app as any).serve ?? (app as any).fetch;
  if (typeof serve === 'function') {
    // biome-ignore lint/suspicious/noExplicitAny: Bun/Deno/Hono variants
    (serve as any).call(app, { port });
  }
}

export default app;

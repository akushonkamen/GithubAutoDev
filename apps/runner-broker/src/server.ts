/**
 * @cgao/runner-broker — Broker HTTP surface.
 *
 * Per spec §13. Dispatches jobs to Trusted Control Runner vs Untrusted Code
 * Runner based on job label, and enforces the no-secret profile on the
 * untrusted side. M0 ships only the /health endpoint + a stub /jobs/:id
 * surface; real dispatch lands in M5 (T-M5-*).
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

export function createApp(): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ status: 'ok', service: 'runner-broker' }));

  app.get('/jobs/:id', (c) => {
    const id = c.req.param('id');
    // M0 stub: real job state comes from the orchestrator state store in M5.
    return c.json(
      {
        id,
        status: 'not_found',
        detail: 'runner-broker M0 skeleton — job dispatch lands in M5',
      },
      404,
    );
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.RUNNER_BROKER_PORT ?? 9100);
  serve({ fetch: createApp().fetch, port }, (info) => {
    console.log(`runner-broker listening on http://localhost:${info.port}`);
  });
}

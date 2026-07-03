import { describe, expect, it } from 'vitest';
import { createApp } from '../server.js';

describe('@cgao/runner-broker server', () => {
  it('GET /health returns ok', async () => {
    const res = await createApp().fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; service: string };
    expect(body).toEqual({ status: 'ok', service: 'runner-broker' });
  });

  it('GET /jobs/:id returns 404 stub', async () => {
    const res = await createApp().fetch(new Request('http://localhost/jobs/run-1'));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { id: string; status: string };
    expect(body.id).toBe('run-1');
    expect(body.status).toBe('not_found');
  });
});

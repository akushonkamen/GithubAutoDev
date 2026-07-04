/**
 * T-B1-007 — boot-smoke test against real Postgres + real runtime mode.
 *
 * Spawns the orchestrator as a subprocess with `CGAO_RUNTIME=real` and
 * a live Postgres, then asserts the HTTP surface is healthy and the
 * webhook HMAC verification path works end-to-end:
 *
 *   - GET  /healthz            → 200, milestone = 'M1'
 *   - GET  /metrics            → text/plain with cgao_ metrics
 *   - POST /github/webhook     unsigned → 401 (rejected)
 *   - POST /github/webhook     properly HMAC-signed `issues.opened` → 200
 *
 * Skipped unless `CGAO_SMOKE=1` is set (so `pnpm -r test` stays green in
 * environments without docker). Run with:
 *
 *   CGAO_SMOKE=1 pnpm --filter @cgao/e2e-tests test -- boot-smoke
 *
 * Pre-conditions (operator must run before invoking):
 *   - `pnpm install`
 *   - `pnpm dev:up`
 *   - `DATABASE_URL=... pnpm db:migrate`
 *
 * The orchestrator is spawned via `tsx` so we don't require every
 * workspace package to be pre-built. The webhook secret is a dev-only
 * value; no real GitHub creds are required because signature
 * verification is local HMAC.
 */

import { spawn } from 'node:child_process';
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const THIS_FILE = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(THIS_FILE), '..', '..', '..', '..');

const ORCH_SRC_SERVER = resolve(REPO_ROOT, 'apps', 'orchestrator', 'src', 'server.ts');
const ORCH_PKG_ROOT = resolve(REPO_ROOT, 'apps', 'orchestrator');

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://cgao:cgao_dev@localhost:5432/cgao';
const WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET ?? 'dev-secret';
const PORT = Number(process.env.SMOKE_PORT ?? 18787); // avoid colliding with dev 8787

const SMOKE_ENABLED = process.env.CGAO_SMOKE === '1';

const HEALTH_URL = `http://localhost:${PORT}/healthz`;
const METRICS_URL = `http://localhost:${PORT}/metrics`;
const WEBHOOK_URL = `http://localhost:${PORT}/github/webhook`;

interface SpawnedOrchestrator {
  child: ReturnType<typeof spawn>;
  exitPromise: Promise<number | null>;
}

function startOrchestrator(): SpawnedOrchestrator {
  if (!existsSync(ORCH_SRC_SERVER)) {
    throw new Error(`boot-smoke: orchestrator source not found at ${ORCH_SRC_SERVER}.`);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CGAO_RUNTIME: 'real',
    DATABASE_URL,
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    PORT: String(PORT),
    // GitHub App creds are intentionally NOT set — the boot-smoke only
    // exercises the webhook signature verification path, which does not
    // require Octokit. buildRuntime() honors CGAO_SMOKE_BOOT=1 to skip
    // Octokit construction entirely.
    CGAO_SMOKE_BOOT: '1',
  };
  // Spawn via tsx so we don't require every workspace package to be
  // pre-built to dist. tsx resolves .ts source + .js relative imports
  // the same way `pnpm dev` does. Invoke through pnpm so the binary
  // resolves correctly under pnpm's strict hoisting.
  const child = spawn('pnpm', ['exec', 'tsx', ORCH_SRC_SERVER], {
    cwd: ORCH_PKG_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
  let stderrBuf = '';
  child.stdout?.on('data', () => {
    // Drain — operator can set CGAO_SMOKE_DEBUG=1 to print.
  });
  child.stderr?.on('data', (d) => {
    stderrBuf += d.toString();
  });
  if (process.env.CGAO_SMOKE_DEBUG === '1') {
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
  }
  const exitPromise = new Promise<number | null>((resolveExit) => {
    child.on('exit', (code) => {
      if (process.env.CGAO_SMOKE_DEBUG === '1') {
        console.error('[boot-smoke] orchestrator exited', code, stderrBuf.slice(-500));
      }
      resolveExit(code);
    });
  });
  return { child, exitPromise };
}

async function waitForHealth(timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(HEALTH_URL);
      if (res.ok) return;
      lastErr = new Error(`status=${res.status}`);
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(
    `boot-smoke: orchestrator never became healthy within ${timeoutMs}ms: ${lastErr}`,
  );
}

function sign(body: string): string {
  return `sha256=${createHmac('sha256', WEBHOOK_SECRET).update(body).digest('hex')}`;
}

describe.skipIf(!SMOKE_ENABLED)(
  'T-B1-007 boot-smoke against real Postgres',
  () => {
    let orch: SpawnedOrchestrator | null = null;

    beforeAll(async () => {
      orch = startOrchestrator();
      await waitForHealth();
    }, 30_000);

    afterAll(async () => {
      if (!orch) return;
      orch.child.kill('SIGTERM');
      // Give it a beat to clean up; force-kill if it hangs.
      const forceKillAt = Date.now() + 5000;
      const result = await Promise.race([
        orch.exitPromise,
        new Promise<void>((r) => setTimeout(r, 5000)),
      ]);
      void result;
      if (orch.child.exitCode === null && Date.now() < forceKillAt) {
        orch.child.kill('SIGKILL');
      }
      orch = null;
    }, 15_000);

    it('GET /healthz returns 200 with milestone=M1', async () => {
      const res = await fetch(HEALTH_URL);
      expect(res.status).toBe(200);
      const json = (await res.json()) as { milestone?: string };
      expect(json.milestone).toBe('M1');
    });

    it('GET /metrics returns text/plain with cgao_ metrics', async () => {
      const res = await fetch(METRICS_URL);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/plain/);
      const body = await res.text();
      // The Prometheus registry emits at least one cgao_ metric line.
      expect(body).toMatch(/cgao_/);
    });

    it('POST /github/webhook with no signature → 401 rejected', async () => {
      const body = JSON.stringify({ action: 'opened' });
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': randomUUID(),
          // intentionally no x-hub-signature-256
          'content-type': 'application/json',
        },
        body,
      });
      expect(res.status).toBe(401);
      const json = (await res.json()) as { kind: string };
      expect(json.kind).toBe('rejected');
    });

    it('POST /github/webhook with valid HMAC-signed issues.opened → 200', async () => {
      const body = JSON.stringify({
        action: 'opened',
        issue: {
          number: 99,
          title: 'cgao: boot-smoke',
          body: 'cgao:new',
          html_url: 'https://github.example/cgao/test/issues/99',
        },
        repository: {
          name: 'test',
          full_name: 'cgao/test',
          owner: { login: 'cgao' },
        },
        sender: { login: 'test-user' },
      });
      const res = await fetch(WEBHOOK_URL, {
        method: 'POST',
        headers: {
          'x-github-event': 'issues',
          'x-github-delivery': randomUUID(),
          'x-hub-signature-256': sign(body),
          'content-type': 'application/json',
        },
        body,
      });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { kind: string };
      // First delivery is accepted; a replay (same delivery id + body)
      // would return deduped. The boot-smoke only fires one delivery.
      expect(json.kind === 'accepted' || json.kind === 'deduped').toBe(true);
    });
  },
  60_000,
);

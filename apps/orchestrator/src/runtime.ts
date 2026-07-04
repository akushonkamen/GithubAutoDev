/**
 * Orchestrator runtime wiring — Plan B Phase 1.
 *
 * `buildRuntime()` reads `CGAO_RUNTIME` and returns the concrete handles the
 * HTTP entry needs:
 *
 *   - `memory` (default): every store + bus is in-memory. Used by tests and
 *     `pnpm dev` without docker. The `__internals` export on server.ts keeps
 *     working because we expose the same map references.
 *   - `real`: Postgres-backed dedup/suppression/workflow-run repos; real
 *     GitHub Octokit adapter; real AuditChainService; ArtifactStore against
 *     MinIO/S3; bus stays in-memory (NATS = Phase 2 — the in-memory bus is
 *     good enough to verify webhook ingest in Phase 1).
 *
 * Required env (when `CGAO_RUNTIME=real`):
 *   - `DATABASE_URL`            — Postgres URL
 *   - `GITHUB_WEBHOOK_SECRET`   — must match GitHub App config
 *   - `GITHUB_APP_ID`           — numeric App ID
 *   - `GITHUB_APP_PRIVATE_KEY`  — `.pem` contents (multi-line) or path
 *   - `GITHUB_INSTALLATION_ID`  — installation id (after App install)
 *   - `CGAO_BOT_LOGIN`          — e.g. `cgao-bot[bot]`
 *
 * Optional:
 *   - `CGAO_REPO_ROOT`          — absolute path for the subprocess git adapter
 *   - `S3_ENDPOINT` / `S3_BUCKET` — MinIO/S3 for ArtifactStore
 */

import type { ArtifactStore } from '@cgao/artifacts';
import type { AuditChainService } from '@cgao/audit';
import type { DbHandle } from '@cgao/db';
import type { EventBus } from '@cgao/eventbus';
import { InMemoryEventBus } from '@cgao/eventbus';
import {
  type GithubAppCredentials,
  GithubOctokitAdapter,
  createGithubAppClient,
} from '@cgao/github';
import { PrometheusRegistry } from '@cgao/observability';
import { InMemoryDedupStore } from './webhook/dedup-store.js';
import { InMemorySuppressionStore } from './webhook/suppression-store.js';

/** Concrete shape handed to server.ts. */
export interface OrchestratorRuntime {
  mode: 'memory' | 'real';
  bus: EventBus;
  dedup: InMemoryDedupStore;
  suppression: InMemorySuppressionStore;
  audit: AuditChainService | null;
  artifacts: ArtifactStore | null;
  github: GithubOctokitAdapter | null;
  db: DbHandle | null;
  metrics: PrometheusRegistry;
}

/**
 * Build the runtime. Caller decides mode via `CGAO_RUNTIME`. Memory mode
 * never throws — real mode throws if any required env is missing.
 */
export async function buildRuntime(): Promise<OrchestratorRuntime> {
  const mode = (process.env.CGAO_RUNTIME ?? 'memory') === 'real' ? 'real' : 'memory';
  const metrics = new PrometheusRegistry();
  // Bus stays in-memory in Phase 1; NATS lands in Phase 2 alongside the
  // module-subscription wiring. Tests + the boot-smoke test rely on this.
  const bus = new InMemoryEventBus();

  if (mode === 'memory') {
    const dedup = makeDedup('memory');
    const suppression = makeSuppression('memory');
    return {
      mode,
      bus,
      dedup,
      suppression,
      audit: null,
      artifacts: null,
      github: null,
      db: null,
      metrics,
    };
  }

  // ---- real mode ----
  const db = await openDb();
  const dedup = makeDedup('real');
  const suppression = makeSuppression('real');
  const github = await buildGithubAdapter();
  return {
    mode,
    bus,
    dedup,
    suppression,
    audit: null, // T-M2 wires the real AuditChainService against Postgres.
    artifacts: null, // T-M2-004 wires the real ArtifactStore.
    github,
    db,
    metrics,
  };
}

/**
 * Build the dedup store. Memory mode returns the InMemoryDedupStore; real
 * mode currently also returns an in-memory store (the `github_deliveries`
 * migration is present, the row-level dedup query ships with the bus
 * wiring in Phase 2 so the dedup-then-publish path stays atomic).
 *
 * Both branches return the InMemoryDedupStore concrete type so the
 * runtime handle's shape matches what `__internals` exposes to tests.
 */
function makeDedup(_mode: 'memory' | 'real'): InMemoryDedupStore {
  return new InMemoryDedupStore();
}

function makeSuppression(_mode: 'memory' | 'real'): InMemorySuppressionStore {
  return new InMemorySuppressionStore();
}

async function openDb(): Promise<DbHandle> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('buildRuntime: DATABASE_URL is required when CGAO_RUNTIME=real');
  }
  // Lazy import so memory-mode boots don't pay the postgres import cost.
  const { createDb } = await import('@cgao/db');
  return createDb({ url });
}

async function buildGithubAdapter(): Promise<GithubOctokitAdapter> {
  const creds = readGithubCreds();
  const handle = await createGithubAppClient(creds);
  return new GithubOctokitAdapter({ octokit: handle.octokit });
}

function readGithubCreds(): GithubAppCredentials {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyRaw = process.env.GITHUB_APP_PRIVATE_KEY;
  const installationId = process.env.GITHUB_INSTALLATION_ID;
  if (!appId || !privateKeyRaw || !installationId) {
    throw new Error(
      'buildRuntime: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_INSTALLATION_ID are required when CGAO_RUNTIME=real',
    );
  }
  return {
    appId,
    privateKey: privateKeyRaw,
    installationId,
    userAgent: process.env.CGAO_APP_USER_AGENT ?? 'cgao-orchestrator',
  };
}

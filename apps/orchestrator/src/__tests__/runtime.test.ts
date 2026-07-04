/**
 * Runtime wiring tests — T-B1-004.
 *
 * Locks the buildRuntime() contract:
 *   - memory mode never throws and returns in-memory handles
 *   - real mode throws a *helpful* error when required env is missing
 *
 * The full real-mode boot path (Postgres + Octokit) is exercised by the
 * boot-smoke e2e test under tests/e2e; this unit test only asserts the
 * configuration gate so it stays fast and hermetic.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildRuntime } from '../runtime.js';

const REAL_VARS = [
  'DATABASE_URL',
  'GITHUB_WEBHOOK_SECRET',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
];

describe('buildRuntime', () => {
  const original = { ...process.env };

  beforeEach(() => {
    // Wipe real-mode env between cases so the memory-mode default is
    // deterministic and the real-mode case starts clean.
    for (const k of REAL_VARS) process.env[k] = undefined;
    process.env.CGAO_RUNTIME = undefined;
  });

  afterEach(() => {
    // Restore — don't leak env mutations to sibling test files.
    process.env = { ...original };
  });

  it('memory mode (default) boots without any env and returns in-memory handles', async () => {
    const rt = await buildRuntime();
    expect(rt.mode).toBe('memory');
    expect(rt.bus).toBeDefined();
    expect(rt.dedup).toBeDefined();
    expect(rt.suppression).toBeDefined();
    expect(rt.metrics).toBeDefined();
    // Memory mode does not wire external surfaces.
    expect(rt.github).toBeNull();
    expect(rt.db).toBeNull();
    expect(rt.audit).toBeNull();
    expect(rt.artifacts).toBeNull();
  });

  it('memory mode is selected for unknown CGAO_RUNTIME values (fail-safe)', async () => {
    process.env.CGAO_RUNTIME = 'banana';
    const rt = await buildRuntime();
    expect(rt.mode).toBe('memory');
  });

  it('real mode throws a helpful error when DATABASE_URL is missing', async () => {
    process.env.CGAO_RUNTIME = 'real';
    // Intentionally leave DATABASE_URL unset.
    await expect(buildRuntime()).rejects.toThrow(/DATABASE_URL/);
  });

  it('real mode throws a helpful error when GitHub App creds are missing', async () => {
    process.env.CGAO_RUNTIME = 'real';
    // DATABASE_URL is set but Postgres is not actually reachable here;
    // createDb() resolves lazily so we get past the URL check and into
    // the GitHub creds check before any network call is attempted.
    // Note: this also documents that GitHub creds are validated before
    // Octokit tries to authenticate.
    process.env.DATABASE_URL = 'postgresql://cgao:cgao_dev@localhost:5432/cgao';
    await expect(buildRuntime()).rejects.toThrow(/GITHUB_APP_ID/);
  });
});

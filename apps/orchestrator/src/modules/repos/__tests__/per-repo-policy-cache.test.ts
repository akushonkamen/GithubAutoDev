/**
 * T-M11-003 PerRepoPolicyCache regression.
 *
 * Contracts (spec §8 / §15):
 *   - Cache hits/misses observable via metrics.
 *   - TTL expiry forces a reload.
 *   - invalidate(installationId) drops entries only for that install.
 *   - Cache key includes installationId (no cross-pollination).
 */

import { describe, expect, it } from 'vitest';
import { PerRepoPolicyCache } from '../per-repo-policy-cache.js';

describe('T-M11-003 PerRepoPolicyCache', () => {
  it('caches loaded value and reports hits/misses', async () => {
    let calls = 0;
    const cache = new PerRepoPolicyCache<string>({
      async load() {
        calls++;
        return 'risk-standard';
      },
    });
    const a = await cache.get({ installationId: 1, repoFullName: 'o/r', kind: 'risk' });
    const b = await cache.get({ installationId: 1, repoFullName: 'o/r', kind: 'risk' });
    expect(a).toBe('risk-standard');
    expect(b).toBe('risk-standard');
    expect(calls).toBe(1);
    expect(cache.metrics.misses).toBe(1);
    expect(cache.metrics.hits).toBe(1);
  });

  it('TTL expiry forces reload', async () => {
    let now = 1000;
    let calls = 0;
    const cache = new PerRepoPolicyCache<string>(
      {
        async load() {
          calls++;
          return `v${calls}`;
        },
      },
      { ttlMs: 100, now: () => now },
    );
    const a = await cache.get({ installationId: 1, repoFullName: 'o/r', kind: 'risk' });
    now += 200; // expire
    const b = await cache.get({ installationId: 1, repoFullName: 'o/r', kind: 'risk' });
    expect(a).toBe('v1');
    expect(b).toBe('v2');
    expect(calls).toBe(2);
  });

  it('invalidate(installationId) drops only that install', async () => {
    const cache = new PerRepoPolicyCache<string>({
      async load({ installationId, repoFullName }) {
        return `${installationId}:${repoFullName}`;
      },
    });
    await cache.get({ installationId: 1, repoFullName: 'o/r', kind: 'risk' });
    await cache.get({ installationId: 2, repoFullName: 'o/r', kind: 'risk' });
    expect(cache.size).toBe(2);
    cache.invalidate(1);
    expect(cache.size).toBe(1);
    expect(cache.metrics.invalidations).toBe(1);
  });

  it('cache key includes installationId (no cross-pollination)', async () => {
    const cache = new PerRepoPolicyCache<string>({
      async load({ installationId }) {
        return `install-${installationId}`;
      },
    });
    const a = await cache.get({ installationId: 1, repoFullName: 'shared/repo', kind: 'risk' });
    const b = await cache.get({ installationId: 2, repoFullName: 'shared/repo', kind: 'risk' });
    expect(a).toBe('install-1');
    expect(b).toBe('install-2');
    expect(cache.metrics.misses).toBe(2);
    expect(cache.metrics.hits).toBe(0);
  });

  it('invalidate(installationId, repoFullName) is scoped', async () => {
    const cache = new PerRepoPolicyCache<string>({
      async load() {
        return 'v';
      },
    });
    await cache.get({ installationId: 1, repoFullName: 'o/a', kind: 'risk' });
    await cache.get({ installationId: 1, repoFullName: 'o/b', kind: 'risk' });
    cache.invalidate(1, 'o/a');
    expect(cache.size).toBe(1);
  });
});

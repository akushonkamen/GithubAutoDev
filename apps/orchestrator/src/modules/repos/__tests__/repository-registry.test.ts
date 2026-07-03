/**
 * T-M11-003 RepositoryRegistry regression.
 *
 * Contracts (spec §8 / §15):
 *   - Two installations with the same repo name do NOT cross-pollinate.
 *   - installationId is in every query key.
 *   - lookup() under wrong installation returns null.
 */

import { describe, expect, it } from 'vitest';
import { InMemoryRepositoryRegistry } from '../repository-registry.js';
import type { RepoContext } from '../repository-registry.js';

function ctx(installationId: number, repo: string, risk = 'standard'): RepoContext {
  return {
    installationId,
    repoFullName: repo,
    defaultBranch: 'main',
    riskPolicyId: risk,
    dependencyWhitelistId: null,
    acl: new Map([['alice', 'admin']]),
  };
}

describe('T-M11-003 RepositoryRegistry', () => {
  it('upsert then lookup returns the registered context', async () => {
    const reg = new InMemoryRepositoryRegistry();
    await reg.upsert(ctx(1001, 'owner/repo'));
    const got = await reg.lookup(1001, 'owner/repo');
    expect(got?.repoFullName).toBe('owner/repo');
  });

  it('two installations with same repo name do NOT cross-pollinate', async () => {
    const reg = new InMemoryRepositoryRegistry();
    await reg.upsert(ctx(1001, 'owner/repo', 'standard'));
    await reg.upsert(ctx(2002, 'owner/repo', 'strict'));
    const a = await reg.lookup(1001, 'owner/repo');
    const b = await reg.lookup(2002, 'owner/repo');
    expect(a?.riskPolicyId).toBe('standard');
    expect(b?.riskPolicyId).toBe('strict');
    // Wrong installation: must return null.
    const wrong = await reg.lookup(9999, 'owner/repo');
    expect(wrong).toBeNull();
  });

  it('list() scopes by installationId', async () => {
    const reg = new InMemoryRepositoryRegistry();
    await reg.upsert(ctx(1001, 'owner/a'));
    await reg.upsert(ctx(1001, 'owner/b'));
    await reg.upsert(ctx(2002, 'owner/c'));
    const list1001 = await reg.list(1001);
    const list2002 = await reg.list(2002);
    expect(list1001.map((c) => c.repoFullName).sort()).toEqual(['owner/a', 'owner/b']);
    expect(list2002.map((c) => c.repoFullName)).toEqual(['owner/c']);
  });

  it('remove() is scoped to (installationId, repoFullName)', async () => {
    const reg = new InMemoryRepositoryRegistry();
    await reg.upsert(ctx(1001, 'owner/repo'));
    await reg.upsert(ctx(2002, 'owner/repo'));
    await reg.remove(1001, 'owner/repo');
    expect(await reg.lookup(1001, 'owner/repo')).toBeNull();
    expect(await reg.lookup(2002, 'owner/repo')).not.toBeNull();
  });
});

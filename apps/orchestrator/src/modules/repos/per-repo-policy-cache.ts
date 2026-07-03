/**
 * Per-repo policy cache — T-M11-003, spec §8 / §15.
 *
 * TTL cache (default 5 minutes) for the policy triple:
 *   - risk policy
 *   - dependency whitelist
 *   - branch protection config
 *
 * Cache key is (installationId, repoFullName, policyKind). The
 * installation id is in every key so two installations with the same
 * repo name never share an entry.
 *
 * Invalidation: `invalidate(installationId, repoFullName?)` drops the
 * matching entries. Callers wire it to the `installation.repositories`
 * change event (GitHub fires this when a repo is added/removed from
 * an installation).
 *
 * Metrics: hits/misses are observable via the registry hooks; tests
 * assert both counters move.
 */

export type PolicyKind = 'risk' | 'dependency_whitelist' | 'branch_protection';

export interface PolicyEntry<T> {
  installationId: number;
  repoFullName: string;
  kind: PolicyKind;
  value: T;
}

export interface PolicyCacheMetrics {
  hits: number;
  misses: number;
  invalidations: number;
}

export interface PolicyLoader<T> {
  load(args: {
    installationId: number;
    repoFullName: string;
  }): Promise<T>;
}

export interface PolicyCacheOptions {
  /** TTL in ms; default 5 minutes. */
  ttlMs?: number;
  /** Wall clock; default Date.now. */
  now?: () => number;
}

interface CacheRecord<T> {
  value: T;
  expiresAt: number;
}

export class PerRepoPolicyCache<T = unknown> {
  private readonly records = new Map<string, CacheRecord<T>>();
  private readonly ttlMs: number;
  private readonly now: () => number;
  readonly metrics: PolicyCacheMetrics = { hits: 0, misses: 0, invalidations: 0 };

  constructor(
    private readonly loader: PolicyLoader<T>,
    options: PolicyCacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? 5 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  async get(args: {
    installationId: number;
    repoFullName: string;
    kind: PolicyKind;
  }): Promise<T> {
    const key = this.key(args.installationId, args.repoFullName, args.kind);
    const rec = this.records.get(key);
    if (rec && rec.expiresAt > this.now()) {
      this.metrics.hits++;
      return rec.value;
    }
    this.metrics.misses++;
    const value = await this.loader.load({
      installationId: args.installationId,
      repoFullName: args.repoFullName,
    });
    this.records.set(key, { value, expiresAt: this.now() + this.ttlMs });
    return value;
  }

  /**
   * Invalidate entries. When repoFullName is omitted, ALL entries for
   * the installation are dropped (used on `installation.repositories`
   * change events).
   */
  invalidate(installationId: number, repoFullName?: string): void {
    const prefix =
      repoFullName === undefined ? `${installationId}|` : `${installationId}|${repoFullName}|`;
    let dropped = 0;
    for (const k of this.records.keys()) {
      if (k.startsWith(prefix)) {
        this.records.delete(k);
        dropped++;
      }
    }
    this.metrics.invalidations += dropped;
  }

  /** For tests: current entry count (including expired, not yet swept). */
  get size(): number {
    return this.records.size;
  }

  private key(installationId: number, repoFullName: string, kind: PolicyKind): string {
    return `${installationId}|${repoFullName}|${kind}`;
  }
}

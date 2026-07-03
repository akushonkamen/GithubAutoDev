/**
 * Repository registry — T-M11-003, spec §8 / §15.
 *
 * Maps (installationId, repoFullName) → RepoContext. The installation
 * id is in EVERY query key so two installations with the same repo
 * name cannot cross-pollinate. The registry is the single source of
 * truth the webhook route and dispatch path consult before triggering
 * any run.
 *
 * Backed by an in-memory Map for unit tests; a Postgres-backed
 * implementation (reading the `installations` / `repositories`
 * tables) lands later via the same interface.
 */

export interface RepoContext {
  /** GitHub App installation id. */
  installationId: number;
  /** Repo full name (e.g. 'owner/repo'). */
  repoFullName: string;
  /** Default branch (e.g. 'main'). */
  defaultBranch: string;
  /** Risk policy id this repo runs under. */
  riskPolicyId: string;
  /** Dependency whitelist id (or null when none). */
  dependencyWhitelistId: string | null;
  /** ACL: actor → role ('admin' | 'write' | 'read'). */
  acl: ReadonlyMap<string, 'admin' | 'write' | 'read'>;
}

export interface RepoRegistryEntry {
  context: RepoContext;
}

export interface RepositoryRegistry {
  upsert(ctx: RepoContext): Promise<void>;
  /**
   * Lookup by (installationId, repoFullName). Throws on cross-install
   * access (returns null when the repo is registered under a different
   * installation — this is the cross-pollination guard).
   */
  lookup(installationId: number, repoFullName: string): Promise<RepoContext | null>;
  list(installationId: number): Promise<readonly RepoContext[]>;
  remove(installationId: number, repoFullName: string): Promise<void>;
}

export class InMemoryRepositoryRegistry implements RepositoryRegistry {
  private readonly entries = new Map<string, RepoContext>();

  private key(installationId: number, repoFullName: string): string {
    return `${installationId}|${repoFullName}`;
  }

  async upsert(ctx: RepoContext): Promise<void> {
    this.entries.set(this.key(ctx.installationId, ctx.repoFullName), ctx);
  }

  async lookup(installationId: number, repoFullName: string): Promise<RepoContext | null> {
    const exact = this.entries.get(this.key(installationId, repoFullName));
    if (exact) return exact;
    // Cross-installation guard: a repo name might exist under a different
    // installation. We deliberately return null here so callers cannot
    // accidentally read another installation's policy. The cross-poll
    // regression asserts this behavior.
    return null;
  }

  async list(installationId: number): Promise<readonly RepoContext[]> {
    const out: RepoContext[] = [];
    for (const ctx of this.entries.values()) {
      if (ctx.installationId === installationId) out.push(ctx);
    }
    return out;
  }

  async remove(installationId: number, repoFullName: string): Promise<void> {
    this.entries.delete(this.key(installationId, repoFullName));
  }
}

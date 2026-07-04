/**
 * Postgres client + drizzle binding — Plan B Phase 1, spec §15.
 *
 * `createDb()` returns a small handle around a `postgres` connection pool
 * with the drizzle schema bound. Repositories in `./repos/postgres/` accept
 * this handle and run queries through drizzle's expression builder.
 *
 * The connection string is read from `DATABASE_URL` (matching the docker
 * compose default) unless the caller supplies one explicitly. Production
 * wiring lives in `apps/orchestrator/src/runtime.ts`; tests pass an
 * explicit url (typically a per-test pg-mem instance).
 */

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export interface CreateDbOptions {
  /** Postgres connection URL. Defaults to `process.env.DATABASE_URL`. */
  url?: string;
  /** Max pool connections. Default 10. */
  poolSize?: number;
  /** Caller-supplied schema override (used by tests). */
  schema?: typeof schema;
}

export interface DbHandle {
  /** Underlying `postgres` driver — used by raw-SQL helpers. */
  readonly client: ReturnType<typeof postgres>;
  /** Drizzle query builder bound to the CGAO schema. */
  readonly db: ReturnType<typeof drizzle>;
  /** Close all connections. Safe to call multiple times. */
  close(): Promise<void>;
}

/**
 * Build a DbHandle bound to the CGAO schema. Caller is responsible for
 * invoking `close()` on shutdown; the orchestrator wires this into the
 * process exit hook.
 */
export function createDb(opts: CreateDbOptions = {}): DbHandle {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (!url) {
    throw new Error('createDb: DATABASE_URL is not set and no url was provided');
  }
  const max = opts.poolSize ?? 10;
  const client = postgres(url, { max, onnotice: () => {} });
  const db = drizzle(client, { schema: opts.schema ?? schema });
  return {
    client,
    db,
    async close(): Promise<void> {
      try {
        await client.end({ timeout: 5 });
      } catch {
        // Ignore — shutting down anyway.
      }
    },
  };
}

export type DrizzleDb = DbHandle['db'];

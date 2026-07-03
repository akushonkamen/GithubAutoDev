/**
 * @cgao/db — PostgreSQL schema for CGAO (spec §15).
 *
 * Exports drizzle table definitions. Migrations live under
 * packages/db/migrations and are produced by `pnpm --filter @cgao/db
 * generate`. The schema is the single source of truth — server code
 * imports table handles from here, never hand-writing SQL.
 */

export * from './schema/index.js';

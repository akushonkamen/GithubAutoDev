/**
 * Read-only base checkout — T-M5-005, spec §13.3.
 *
 * Conceptual surface: the agent runs against a clean checkout at a
 * pinned base SHA. The checkout is READ-ONLY at the filesystem layer
 * for the agent process; all writes go through the WriteOverlay.
 *
 * M5 ships an in-memory representation. The real implementation
 * (overlay FS / bind-mount) lands when the runner-broker dispatches
 * real subprocesses (M5 follow-on).
 */

export interface ReadOnlyBase {
  /** Absolute path to the checkout root. */
  root: string;
  /** Base SHA the checkout was materialized at. */
  baseSha: string;
  /** Files present at checkout time (relative paths). */
  files: readonly string[];
}

export function defineReadOnlyBase(
  root: string,
  baseSha: string,
  files: readonly string[],
): ReadOnlyBase {
  return { root, baseSha, files: [...files] };
}

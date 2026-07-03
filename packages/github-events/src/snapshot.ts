/**
 * Issue snapshot + material-change detection — T-M2-003, spec §9.4 / §9.5.
 *
 * A snapshot is a content-addressed hash of the canonical issue
 * material fields (title + body). The detector decides whether a
 * new snapshot should bump the run's `generation` counter.
 *
 * Material change rules:
 *  - title or body change → material (new generation)
 *  - label projection change → not material (doesn't invalidate
 *    spec/plan/approval; only triage state is affected)
 *
 * Spec §9.5 also requires that events carrying an older generation
 * are routed to stale_event instead of business topics. That routing
 * lives in the orchestrator; this module only exposes the helper
 * `isStale(currentGen, eventGen)`.
 */

import { createHash } from 'node:crypto';

export interface IssueSnapshotInput {
  title: string;
  body: string | null;
}

export interface IssueSnapshot {
  /** sha256 of the canonical material (title|body). */
  sha: string;
  title: string;
  body: string | null;
}

export function canonicalIssueBody(body: string | null): string {
  // Normalize: trim trailing whitespace per line, collapse blank-line runs.
  // GitHub sometimes injects trailing whitespace; we want cosmetic edits
  // to not bump generation.
  if (!body) return '';
  return body
    .split('\n')
    .map((l) => l.replace(/\s+$/u, ''))
    .join('\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim();
}

export function snapshotIssue(input: IssueSnapshotInput): IssueSnapshot {
  const canonical = `${input.title.trim()}\n${canonicalIssueBody(input.body)}`;
  const sha = createHash('sha256').update(canonical).digest('hex');
  return { sha, title: input.title.trim(), body: input.body };
}

export interface MaterialChangeResult {
  material: boolean;
  prevSha: string | null;
  nextSha: string;
}

export function detectMaterialChange(
  prev: IssueSnapshot | null,
  next: IssueSnapshot,
): MaterialChangeResult {
  if (!prev) {
    return { material: true, prevSha: null, nextSha: next.sha };
  }
  return {
    material: prev.sha !== next.sha,
    prevSha: prev.sha,
    nextSha: next.sha,
  };
}

export function isStale(currentGeneration: number, eventGeneration: number | null): boolean {
  if (eventGeneration === null || eventGeneration === undefined) return false;
  return eventGeneration < currentGeneration;
}

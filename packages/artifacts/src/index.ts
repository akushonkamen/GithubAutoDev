/**
 * @cgao/artifacts — Artifact Store interface and hash computation.
 *
 * Per spec §15 (Artifact Store). Owns the content-addressed artifact shape:
 * every artifact is `sha256(content)` keyed and tagged with a kind
 * (`spec` | `plan` | `review` | `raw_payload` | ...). Actual storage adapter
 * (S3 / GCS / MinIO / local FS) lands in M2 — this package only owns the
 * types and the pure hash function so producers can compute keys today.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';

export const artifactKindSchema = z.enum([
  'spec',
  'plan',
  'review',
  'raw_payload',
  'implementation_note',
]);

export type ArtifactKind = z.infer<typeof artifactKindSchema>;

export const artifactSchema = z.object({
  kind: artifactKindSchema,
  /** Content-addressed key: `sha256:<hex>`. */
  key: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
  /** Original content as UTF-8 string (JSON-encoded for structured artifacts). */
  content: z.string(),
  /** Repo the artifact belongs to. */
  repo: z.string().min(1),
  /** Workflow run lookup key (nullable for raw payloads before run is known). */
  runId: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export type Artifact = z.infer<typeof artifactSchema>;

/** Compute the content-addressed key for an artifact body. */
export function computeArtifactKey(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

/** Storage adapter interface — M2 wires concrete impls (FS / S3 / MinIO). */
export interface ArtifactStore {
  write(artifact: Artifact): Promise<void>;
  read(key: string): Promise<Artifact | null>;
  list(filter: { repo: string; runId?: string; kind?: ArtifactKind }): Promise<Artifact[]>;
}

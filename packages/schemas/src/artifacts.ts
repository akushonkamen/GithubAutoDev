/**
 * Artifact kind discriminators per spec §11.
 * Each Artifact has a kind, a sha256 content hash, and a content blob.
 */
import { z } from 'zod';

export const artifactKinds = [
  'requirement_spec',
  'implementation_plan',
  'approval_record',
  'handoff',
  'review_findings',
  'test_report',
  'merge_record',
  'intake_decision',
] as const;

export type ArtifactKind = (typeof artifactKinds)[number];

export const artifactRefSchema = z.object({
  kind: z.enum(artifactKinds),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u, 'sha256 hex digest'),
  size: z.number().int().nonnegative(),
  uri: z.string().url(),
  generated_at: z.string().datetime(),
  generator: z.enum([
    'mod_analysis',
    'mod_plan',
    'mod_review',
    'mod_test',
    'mod_merge',
    'mod_intake',
  ]),
});

export type ArtifactRef = z.infer<typeof artifactRefSchema>;

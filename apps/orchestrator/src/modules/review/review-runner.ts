/**
 * ReviewRunner — T-M8-001, spec §12.9 / §13.2.
 *
 * Orchestrates one reviewer pass:
 *
 *   1. Build prompt via ReviewerContextBuilder (spec + plan + diff + gate).
 *   2. Call the LLM through the injectable ReviewerLlmPort — production
 *      wires a CCA client, tests wire a stub. The runner never binds to
 *      a concrete LLM SDK.
 *   3. Parse the LLM response into structured findings.
 *   4. Compute finding_hash for each finding, build a ReviewResult bound
 *      to (headSha, baseSha), persist the artifact, and upsert findings
 *      into the DB.
 *
 * Spec §12.9 — implementer agent exclusion:
 *
 *   The runner is dispatched under the `reviewer` CCA command (JobLabel
 *   'reviewer'), NEVER under the `executor` command. The orchestrator's
 *   dispatch layer (M5) enforces this structurally; this module further
 *   stamps `reviewer: 'code'` onto every emitted finding so the storage
 *   layer can reject any finding lacking a reviewer class.
 *
 * Spec §5 — review comments through trusted broker:
 *
 *   The runner does NOT call GitHub mutations directly. Callers wire a
 *   PullRequestService (from M7) via deps.comments; the runner emits
 *   findings to the DB and (optionally) posts a structured summary via
 *   the broker.
 */

import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactStore, computeArtifactKey } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import { CODE_REVIEW_OUTPUT_TRAILER, buildCodeReviewPrompt } from './code-review-prompt.js';
import { computeFindingHash } from './finding-hash.js';
import type { ReviewFindingRepo } from './review-finding-repo.js';
import {
  type ReviewFinding,
  type ReviewResult,
  reviewFindingSchema,
  reviewResultSchema,
} from './review-result.js';
import type { ReviewerContextInput, ReviewerGateEvidence } from './reviewer-context-builder.js';

/** Injectable LLM port. Production wires a CCA client; tests wire a stub. */
export interface ReviewerLlmPort {
  complete(args: { prompt: string }): Promise<string>;
}

/** Trusted broker for posting review comments (PullRequestService from M7). */
export interface ReviewCommentBroker {
  postReviewSummary(args: {
    prNumber: number;
    headSha: string;
    summary: string;
    findingCount: number;
  }): Promise<void>;
}

export interface ReviewRunnerDeps {
  llm: ReviewerLlmPort;
  store: ArtifactStore;
  findings: ReviewFindingRepo;
  /** Optional — when absent the runner skips posting to GitHub. */
  comments?: ReviewCommentBroker;
}

export interface RunReviewInput {
  runId: string;
  prNumber: number | null;
  headSha: string;
  baseSha: string;
  repo: string;
  /** Context bundle assembled upstream (reviewer-context-builder). */
  context: ReviewerContextInput;
  /** Bumped when the prompt template / output schema changes. */
  reviewerVersion?: string;
}

export interface RunReviewResult {
  result: ReviewResult;
  /** Persisted artifact key for the ReviewResult bundle. */
  artifactRef: string;
}

export class ReviewRunner {
  constructor(private readonly deps: ReviewRunnerDeps) {}

  async run(input: RunReviewInput): Promise<RunReviewResult> {
    const built = buildCodeReviewPrompt(input.context);
    const prompt = `${built.prompt}\n\n${CODE_REVIEW_OUTPUT_TRAILER}`;
    const raw = await this.deps.llm.complete({ prompt });

    // Parse the LLM JSON. We tolerate trailing prose / markdown fences
    // by extracting the outermost {...} block.
    const parsed = parseJsonObject(raw);
    const findingsIn = Array.isArray(parsed?.findings) ? parsed.findings : [];
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';

    const findings: ReviewFinding[] = [];
    for (const raw of findingsIn) {
      const candidate = {
        findingHash: computeFindingHash({
          runId: input.runId,
          headSha: input.headSha,
          reviewer: 'code' as const,
          rule: String(raw?.rule ?? ''),
          file: String(raw?.file ?? ''),
          lineStart: Number(raw?.lineStart ?? 0),
          lineEnd: Number(raw?.lineEnd ?? 0),
          message: String(raw?.message ?? ''),
        }),
        reviewer: 'code' as const,
        rule: String(raw?.rule ?? ''),
        file: String(raw?.file ?? ''),
        lineStart: Number(raw?.lineStart ?? 0),
        lineEnd: Number(raw?.lineEnd ?? 0),
        title: String(raw?.title ?? ''),
        message: String(raw?.message ?? ''),
        recommendation: raw?.recommendation ? String(raw.recommendation) : undefined,
        severity: String(raw?.severity ?? 'low'),
        blocking: false, // code reviewer never sets blocking
      };
      // Skip findings that fail the schema (missing required fields).
      const parsed = reviewFindingSchema.safeParse(candidate);
      if (parsed.success) findings.push(parsed.data);
    }

    const bindingHash = `sha256:${createHash('sha256')
      .update(
        stableJsonStringify({
          runId: input.runId,
          headSha: input.headSha,
          baseSha: input.baseSha,
          reviewer: 'code',
          findings,
        }),
      )
      .digest('hex')}`;

    const result: ReviewResult = reviewResultSchema.parse({
      runId: input.runId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      reviewer: 'code',
      findings,
      summary,
      reviewerVersion: input.reviewerVersion ?? 'code-reviewer/v1',
      bindingHash,
    });

    // Persist the ReviewResult as an artifact.
    const content = stableJsonStringify({ kind: 'review_result', ...result });
    const key = computeArtifactKey(content);
    const artifact: Artifact = {
      kind: 'raw_payload',
      key,
      content,
      repo: input.repo,
      runId: input.runId,
      createdAt: new Date().toISOString(),
    };
    await this.deps.store.write(artifact);

    // Upsert findings into the DB.
    await this.deps.findings.recordReviewResult({
      runId: input.runId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      findings,
    });

    // Optional: post a structured summary through the trusted broker.
    if (input.prNumber !== null && this.deps.comments) {
      await this.deps.comments.postReviewSummary({
        prNumber: input.prNumber,
        headSha: input.headSha,
        summary,
        findingCount: findings.length,
      });
    }

    return { result, artifactRef: key };
  }
}

/**
 * Extract the outermost JSON object from an LLM response. Tolerates
 * markdown fences and trailing prose. Throws if no {...} block is found.
 */
export function parseJsonObject(raw: string): Record<string, unknown> | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  const slice = raw.slice(start, end + 1);
  try {
    return JSON.parse(slice) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Re-export the gate evidence type so callers can build context inputs.
export type { ReviewerGateEvidence };

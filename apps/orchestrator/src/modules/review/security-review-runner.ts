/**
 * SecurityReviewRunner — T-M8-002, spec §12.9.
 *
 * Mirrors ReviewRunner but:
 *   - uses the security-reviewer prompt + output trailer;
 *   - dispatches under CCA command `reviewer` with the security profile;
 *   - stamps `reviewer: 'security'` on every finding;
 *   - enforces the severity floor (LLM cannot downgrade critical → low);
 *   - honors `blocking` from the LLM (security findings may block merge).
 */

import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactStore, computeArtifactKey } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import { computeFindingHash } from './finding-hash.js';
import type { ReviewFindingRepo } from './review-finding-repo.js';
import { type ReviewResult, reviewResultSchema } from './review-result.js';
import {
  type ReviewCommentBroker,
  type ReviewerLlmPort,
  parseJsonObject,
} from './review-runner.js';
import type { ReviewerContextInput } from './reviewer-context-builder.js';
import {
  type SecurityFinding,
  enforceSeverityFloor,
  securityFindingSchema,
} from './security-finding.js';
import {
  SECURITY_REVIEW_OUTPUT_TRAILER,
  buildSecurityReviewPrompt,
} from './security-review-prompt.js';

export type { ReviewerLlmPort, ReviewCommentBroker } from './review-runner.js';

export interface SecurityReviewRunnerDeps {
  llm: ReviewerLlmPort;
  store: ArtifactStore;
  findings: ReviewFindingRepo;
  comments?: ReviewCommentBroker;
}

export interface RunSecurityReviewInput {
  runId: string;
  prNumber: number | null;
  headSha: string;
  baseSha: string;
  repo: string;
  context: ReviewerContextInput;
  reviewerVersion?: string;
}

export interface RunSecurityReviewResult {
  result: ReviewResult;
  artifactRef: string;
}

export class SecurityReviewRunner {
  constructor(private readonly deps: SecurityReviewRunnerDeps) {}

  async run(input: RunSecurityReviewInput): Promise<RunSecurityReviewResult> {
    const built = buildSecurityReviewPrompt(input.context);
    const prompt = `${built.prompt}\n\n${SECURITY_REVIEW_OUTPUT_TRAILER}`;
    const raw = await this.deps.llm.complete({ prompt });

    const parsed = parseJsonObject(raw);
    const findingsIn = Array.isArray(parsed?.findings) ? parsed.findings : [];
    const summary = typeof parsed?.summary === 'string' ? parsed.summary : '';

    const findings: SecurityFinding[] = [];
    for (const f of findingsIn) {
      const rule = String(f?.rule ?? '');
      const reportedSeverity = String(f?.severity ?? 'low');
      const severity = enforceSeverityFloor(
        rule,
        reportedSeverity as 'low' | 'medium' | 'high' | 'critical',
      );
      const candidate = {
        findingHash: computeFindingHash({
          runId: input.runId,
          headSha: input.headSha,
          reviewer: 'security' as const,
          rule,
          file: String(f?.file ?? ''),
          lineStart: Number(f?.lineStart ?? 0),
          lineEnd: Number(f?.lineEnd ?? 0),
          message: String(f?.message ?? ''),
        }),
        reviewer: 'security' as const,
        rule,
        file: String(f?.file ?? ''),
        lineStart: Number(f?.lineStart ?? 0),
        lineEnd: Number(f?.lineEnd ?? 0),
        title: String(f?.title ?? ''),
        message: String(f?.message ?? ''),
        recommendation: f?.recommendation ? String(f.recommendation) : undefined,
        severity,
        blocking: Boolean(f?.blocking),
      };
      const safe = securityFindingSchema.safeParse(candidate);
      if (safe.success) findings.push(safe.data);
    }

    const bindingHash = `sha256:${createHash('sha256')
      .update(
        stableJsonStringify({
          runId: input.runId,
          headSha: input.headSha,
          baseSha: input.baseSha,
          reviewer: 'security',
          findings,
        }),
      )
      .digest('hex')}`;

    const result: ReviewResult = reviewResultSchema.parse({
      runId: input.runId,
      headSha: input.headSha,
      baseSha: input.baseSha,
      reviewer: 'security',
      findings,
      summary,
      reviewerVersion: input.reviewerVersion ?? 'security-reviewer/v1',
      bindingHash,
    });

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

    await this.deps.findings.recordReviewResult({
      runId: input.runId,
      prNumber: input.prNumber,
      headSha: input.headSha,
      findings,
    });

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

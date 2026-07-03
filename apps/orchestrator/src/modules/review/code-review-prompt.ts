/**
 * CodeReviewPrompt — T-M8-001, spec §12.9 / §13.2.
 *
 * Builds the code-reviewer prompt from a diff + handoff context. The
 * prompt is assembled by ReviewerContextBuilder; this module owns the
 * code-reviewer-specific instructions and the output schema reminder.
 *
 * The diff content is UNTRUSTED — it contains user code — and is wrapped
 * via wrapUntrusted() by the context builder. Reviewer-instruction text
 * is trusted (cgao-authored).
 */

import type { Handoff } from '../specs/handoff.js';
import type { ImplementationPlan } from '../specs/implementation-plan.js';
import type { RequirementSpec } from '../specs/requirement-spec.js';
import {
  type BuiltReviewerContext,
  type ReviewerGateEvidence,
  buildReviewerContext,
} from './reviewer-context-builder.js';

export interface BuildCodeReviewPromptInput {
  spec: RequirementSpec;
  plan: ImplementationPlan;
  handoff: Handoff;
  diff: string;
  gate: ReviewerGateEvidence;
}

/**
 * Render the code-reviewer prompt. Returns the full prompt string plus
 * the redaction report from the underlying context builder.
 */
export function buildCodeReviewPrompt(input: BuildCodeReviewPromptInput): BuiltReviewerContext {
  return buildReviewerContext({
    spec: input.spec,
    plan: input.plan,
    handoff: input.handoff,
    diff: input.diff,
    gate: input.gate,
  });
}

/**
 * Output-format instructions appended to the LLM call. The ReviewRunner
 * concatenates the rendered prompt with this trailer before invoking the
 * LLM port. Kept separate so the security-reviewer can reuse the
 * rendered prompt with its own trailer.
 */
export const CODE_REVIEW_OUTPUT_TRAILER = [
  'Emit JSON matching this TypeScript shape (no prose, no markdown fence):',
  '{',
  '  "findings": [',
  '    {',
  '      "rule": "<rule-id>",',
  '      "file": "<path>",',
  '      "lineStart": <int>,',
  '      "lineEnd": <int>,',
  '      "title": "<short>",',
  '      "message": "<detail>",',
  '      "recommendation": "<optional fix>",',
  '      "severity": "low" | "medium" | "high" | "critical",',
  '      "blocking": false',
  '    }',
  '  ],',
  '  "summary": "<one-paragraph overall assessment>"',
  '}',
  'The code reviewer MUST leave "blocking" = false; blocking findings',
  'are owned by the security reviewer.',
].join('\n');

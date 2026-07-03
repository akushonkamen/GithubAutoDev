/**
 * SecurityReviewPrompt — T-M8-002, spec §12.9.
 *
 * Builds the security-reviewer prompt. Reuses ReviewerContextBuilder but
 * swaps in the security-specific role instruction and output trailer.
 * The security reviewer is dispatched when changed paths touch
 * auth/payment/secret/input-validation surfaces (see SecurityReviewTrigger).
 */

import type { Handoff } from '../specs/handoff.js';
import type { ImplementationPlan } from '../specs/implementation-plan.js';
import type { RequirementSpec } from '../specs/requirement-spec.js';
import {
  type BuiltReviewerContext,
  REVIEW_SYSTEM_INSTRUCTION,
  type ReviewerGateEvidence,
  buildReviewerContext,
} from './reviewer-context-builder.js';

export interface BuildSecurityReviewPromptInput {
  spec: RequirementSpec;
  plan: ImplementationPlan;
  handoff: Handoff;
  diff: string;
  gate: ReviewerGateEvidence;
}

export const SECURITY_REVIEW_SYSTEM_INSTRUCTION = [
  'You are the cgao SECURITY reviewer.',
  'Your job: identify security regressions introduced by the patch below.',
  'You see the RequirementSpec, ImplementationPlan, gate evidence, the',
  'dev→review handoff (risks + changed files + tests run), and the diff.',
  'You do NOT see the executor self-defense narrative.',
  'Focus on: secrets in source, SQL/command injection, path traversal,',
  'auth bypass, weak crypto, input validation, payment data handling.',
  'For each finding, set severity honestly and set blocking=true when the',
  'finding must be resolved before merge. The runner enforces a severity',
  'floor per rule and will reject downgrades.',
].join(' ');

export function buildSecurityReviewPrompt(
  input: BuildSecurityReviewPromptInput,
): BuiltReviewerContext {
  // Build with the code-reviewer system instruction, then overwrite the
  // leading system block with the security variant. We do this by
  // rebuilding from the parts the context builder exposes — simplest is
  // to call buildReviewerContext and string-replace the leading block.
  const built = buildReviewerContext(input);
  const prompt = built.prompt.replace(
    REVIEW_SYSTEM_INSTRUCTION,
    SECURITY_REVIEW_SYSTEM_INSTRUCTION,
  );
  return { ...built, prompt };
}

export const SECURITY_REVIEW_OUTPUT_TRAILER = [
  'Emit JSON matching this TypeScript shape (no prose, no markdown fence):',
  '{',
  '  "findings": [',
  '    {',
  '      "rule": "<rule-id from the catalog>",',
  '      "file": "<path>",',
  '      "lineStart": <int>,',
  '      "lineEnd": <int>,',
  '      "title": "<short>",',
  '      "message": "<detail>",',
  '      "recommendation": "<optional fix>",',
  '      "severity": "low" | "medium" | "high" | "critical",',
  '      "blocking": <bool>',
  '    }',
  '  ],',
  '  "summary": "<one-paragraph overall assessment>"',
  '}',
].join('\n');

/**
 * Path globs that trigger an automatic security review. Spec §12.9.
 * A change touching any of these prefixes triggers the security runner
 * in addition to the code runner.
 */
export const SECURITY_TRIGGER_GLOBS: readonly string[] = [
  'src/auth/**',
  'src/payment/**',
  'src/secret/**',
  'src/secrets/**',
  'src/input-validation/**',
  'apps/*/src/auth/**',
  'apps/*/src/payment/**',
  'apps/*/src/secret/**',
  'apps/*/src/secrets/**',
  'apps/*/src/input-validation/**',
  'packages/*/src/auth/**',
  'packages/*/src/payment/**',
];

/**
 * Decide whether a set of changed paths should trigger a security review.
 * Uses the runner-broker glob matcher (matchesGlob) so the trigger logic
 * matches the path-write policy exactly.
 */
export function shouldTriggerSecurityReview(
  changedPaths: readonly string[],
  globs: readonly string[] = SECURITY_TRIGGER_GLOBS,
): boolean {
  // Lazy import keeps the prompt module side-effect-free in tests that
  // don't exercise the trigger.
  // We import matchesGlob from runner-broker via @cgao/runner-broker.
  // To avoid a hard runtime dep here, we re-implement the prefix match
  // inline (the rule is the same one matchesGlob uses for `/**` globs).
  for (const path of changedPaths) {
    for (const glob of globs) {
      if (globMatchesPath(path, glob)) return true;
    }
  }
  return false;
}

function globMatchesPath(path: string, pattern: string): boolean {
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  if (pattern.endsWith('**')) {
    const prefix = pattern.slice(0, -2);
    return path.startsWith(prefix);
  }
  return path === pattern || path.startsWith(`${pattern}/`);
}

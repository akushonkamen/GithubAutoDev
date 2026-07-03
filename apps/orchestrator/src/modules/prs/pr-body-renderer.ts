/**
 * PR body renderer — T-M7-004, spec §12.8 / §14.2.
 *
 * Assembles the full PR body from a trusted summary + the
 * traceability block. The body is what cgao posts to GitHub and is
 * the human-facing surface for the run.
 *
 * Defense-in-depth: although the body is trusted (cgao-authored),
 * any downstream consumer that wraps the body for an LLM MUST pass
 * it through wrapUntrusted() first. The body's `wrapped` field is
 * pre-computed for that path so a downstream summarizer cannot
 * accidentally concatenate raw body text into a prompt.
 */

import { wrapUntrusted } from '../intake/envelope.js';
import {
  type GateSummary,
  type TraceabilityBlockInput,
  renderTraceabilityBlock,
} from './traceability-block.js';

export interface PrBodyInput extends Omit<TraceabilityBlockInput, 'gateSummary'> {
  /** Short headline summary (trusted, written by cgao). */
  summary: string;
  /** Optional gate summary. */
  gateSummary?: GateSummary;
}

/**
 * Render the PR body. Layout:
 *
 *   ## cgao: <summary>
 *
 *   <traceability block>
 *
 *   ---
 *
 *   cgao authored this PR. Do not edit the traceability table.
 */
export function renderPrBody(input: PrBodyInput): string {
  if (!input.summary || !input.summary.trim()) {
    throw new Error('PrBody: summary must be non-empty');
  }
  const block = renderTraceabilityBlock({
    issueNumber: input.issueNumber,
    repo: input.repo,
    runId: input.runId,
    specId: input.specId,
    planId: input.planId,
    planSha: input.planSha,
    headSha: input.headSha,
    baseSha: input.baseSha,
    gateSummary: input.gateSummary,
  });
  const lines: string[] = [];
  lines.push(`## cgao: ${input.summary}`);
  lines.push('');
  lines.push(block);
  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push('_cgao authored this PR. Do not edit the traceability table above._');
  return lines.join('\n');
}

/**
 * Wrap a PR body for downstream LLM consumption. Returns the body
 * untouched plus the wrapped form — callers that summarize a PR body
 * MUST use the wrapped variant so a malicious maintainer-edit cannot
 * escape the untrusted envelope.
 */
export function wrapPrBodyForLlm(body: string): { raw: string; wrapped: string } {
  return { raw: body, wrapped: wrapUntrusted(body) };
}

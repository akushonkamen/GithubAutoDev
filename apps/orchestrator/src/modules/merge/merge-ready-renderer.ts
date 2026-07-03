/**
 * MergeReadyRenderer — T-M9-003, spec §12.10 / §14.2.
 *
 * Renders the markdown summary posted to the PR when every gate is
 * green and the final evaluator returned `decision: 'merge'`.
 *
 * Hard contracts (spec §14.2, §5):
 *
 *   - The body NEVER contains internal `artifact://` URIs. Evidence
 *     references stay internal — only human-readable prose is exposed.
 *     A regex assert in __tests__ locks this in.
 *   - The body interpolates only trusted, cgao-authored values. PR
 *     titles / issue bodies are never concatenated here.
 *   - The comment uses cgao's existing status-comment marker envelope
 *     so the StatusCommentUpdater can locate and edit it in place.
 */

import type { AggregatedGates, GateEvaluation, GateKind } from './types.js';

const ARTIFACT_URI_RE = /artifact:\/\/[^\s)]+/u;

const STATUS_MARKER_BEGIN = '<!-- cgao:merge-ready';
const STATUS_MARKER_END = '-->';

export interface RenderMergeReadyInput {
  /** Aggregated gates (one entry per kind; missing => not satisfied). */
  aggregated: AggregatedGates;
  /** PR number the comment will be posted to (display only). */
  prNumber: number;
  /** HMAC-authenticated marker string for the workflow run. */
  statusMarker?: string;
}

/**
 * Render a per-gate check line: ✓ / ✗ followed by a short label.
 * ASCII-only fallback is intentional — no emoji dependency.
 */
function gateLine(kind: GateKind, gate: GateEvaluation | undefined): string {
  const label: Record<GateKind, string> = {
    test: 'lint / typecheck / unit',
    ai_review: 'AI code + security review',
    human_review: 'human approval',
    risk_policy: 'risk policy',
    security_findings: 'blocking security findings',
  };
  const ok = gate?.passed === true;
  const mark = ok ? 'PASS' : 'FAIL';
  const detail = gate?.reason ?? 'gate missing';
  return `- [${mark}] ${label[kind]}: ${detail}`;
}

/**
 * Render the markdown body for the merge-ready comment.
 *
 * Throws if the body accidentally ends up with an `artifact://` URI —
 * that would be a privacy/security leak (internal storage URIs MUST
 * stay internal). Tests assert this rule.
 */
export function renderMergeReadyBody(input: RenderMergeReadyInput): string {
  const a = input.aggregated;
  const lines: string[] = [];
  lines.push(`## cgao: merge-ready`);
  lines.push('');
  lines.push(`PR #${input.prNumber} is ready to merge. All gates passed at \`${a.headSha.slice(0, 10)}\`.`);
  lines.push('');
  lines.push('| Gate | Status |');
  lines.push('|---|---|');
  const order: readonly GateKind[] = [
    'test',
    'ai_review',
    'human_review',
    'risk_policy',
    'security_findings',
  ];
  for (const k of order) {
    const g = a.gates[k];
    const ok = g?.passed === true;
    const detail = g?.reason ?? 'gate missing';
    lines.push(`| ${k.replace(/_/gu, ' ')} | ${ok ? 'PASS' : 'FAIL'} — ${detail} |`);
  }
  lines.push('');
  lines.push('Gate details:');
  for (const k of order) {
    lines.push(gateLine(k, a.gates[k]));
  }
  if (a.excludedStale.length > 0) {
    lines.push('');
    lines.push(`Stale signals excluded: ${a.excludedStale.length}.`);
  }
  lines.push('');
  lines.push('_cgao authored this comment. Do not edit the marker below._');

  const marker = input.statusMarker
    ? `\n\n<!-- cgao:run_id=${a.runId} state=MERGE_READY comment_role=merge mac=${input.statusMarker} -->`
    : `\n\n${STATUS_MARKER_BEGIN} run=${a.runId} ${STATUS_MARKER_END}`;
  const body = lines.join('\n').concat(marker);

  // Defense-in-depth: the body MUST NEVER contain an internal artifact URI.
  if (ARTIFACT_URI_RE.test(body)) {
    throw new Error(
      'renderMergeReadyBody: body contains an internal artifact:// URI; refusing to expose',
    );
  }
  return body;
}

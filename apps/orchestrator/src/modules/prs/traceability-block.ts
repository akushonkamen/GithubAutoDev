/**
 * Traceability block — T-M7-004, spec §12.8 / §14.2.
 *
 * Emits a clearly-labeled markdown block listing every traceability
 * field a maintainer needs to find the run, spec, plan, head/base
 * sha, and gate summary from a PR.
 *
 * Contracts:
 *
 *   - The block is DISPLAY-ONLY. It MUST NOT contain internal
 *     `artifact://` URIs — those are orchestrator-internal and would
 *     leak the artifact store layout. Spec §5: PR comment markers are
 *     display-only, never authoritative.
 *   - The fields are the trusted, SHA-bound ones (issue url, run id,
 *     spec id, plan id@plan sha, head sha, gate summary).
 *   - Inputs are validated; if a field is empty/whitespace the
 *     renderer throws so callers cannot silently ship a malformed PR.
 */

export interface GateSummary {
  /** Counts per gate name (lint / typecheck / unit). */
  readonly lint?: { passed: number; failed: number };
  readonly typecheck?: { passed: number; failed: number };
  readonly unit?: { passed: number; failed: number };
}

export interface TraceabilityBlockInput {
  /** Issue number (for the URL fragment). */
  issueNumber: number;
  /** Repo in owner/name form (for the issue URL). */
  repo: string;
  /** Workflow run id. */
  runId: string;
  /** Requirement spec id. */
  specId: string;
  /** Implementation plan id. */
  planId: string;
  /** Plan sha (64-hex). */
  planSha: string;
  /** PR head sha. */
  headSha: string;
  /** PR base sha. */
  baseSha: string;
  /** Optional gate summary (lint / typecheck / unit pass counts). */
  gateSummary?: GateSummary;
}

const ARTIFACT_URI_REGEX = /\bartifact:\/\/\S+/u;

export class TraceabilityBlockError extends Error {
  constructor(message: string, readonly field: string) {
    super(message);
    this.name = 'TraceabilityBlockError';
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (!value || !value.trim()) {
    throw new TraceabilityBlockError(`${field} must be non-empty`, field);
  }
}

/**
 * Render the traceability block as markdown. Pure — no I/O.
 */
export function renderTraceabilityBlock(input: TraceabilityBlockInput): string {
  assertNonEmpty(input.repo, 'repo');
  assertNonEmpty(input.runId, 'runId');
  assertNonEmpty(input.specId, 'specId');
  assertNonEmpty(input.planId, 'planId');
  assertNonEmpty(input.headSha, 'headSha');
  assertNonEmpty(input.baseSha, 'baseSha');
  if (!/^[0-9a-f]{64}$/u.test(input.planSha)) {
    throw new TraceabilityBlockError('planSha must be 64 hex chars', 'planSha');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.headSha)) {
    throw new TraceabilityBlockError('headSha must be 64 hex chars', 'headSha');
  }
  if (!/^[0-9a-f]{64}$/u.test(input.baseSha)) {
    throw new TraceabilityBlockError('baseSha must be 64 hex chars', 'baseSha');
  }
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
    throw new TraceabilityBlockError('issueNumber must be a positive integer', 'issueNumber');
  }

  const issueUrl = `https://github.com/${input.repo}/issues/${input.issueNumber}`;
  const lines: string[] = [];
  lines.push('## cgao traceability');
  lines.push('');
  lines.push('| Field | Value |');
  lines.push('|---|---|');
  lines.push(`| Issue | [#${input.issueNumber}](${issueUrl}) |`);
  lines.push(`| Run | \`${input.runId}\` |`);
  lines.push(`| Spec | \`${input.specId}\` |`);
  lines.push(`| Plan | \`${input.planId}@${input.planSha.slice(0, 12)}\` |`);
  lines.push(`| Head | \`${input.headSha.slice(0, 12)}\` |`);
  lines.push(`| Base | \`${input.baseSha.slice(0, 12)}\` |`);

  if (input.gateSummary) {
    lines.push('');
    lines.push('### Gate summary');
    lines.push('');
    lines.push('| Gate | Passed | Failed |');
    lines.push('|---|---|---|');
    const g = input.gateSummary;
    if (g.lint) lines.push(`| lint | ${g.lint.passed} | ${g.lint.failed} |`);
    if (g.typecheck) lines.push(`| typecheck | ${g.typecheck.passed} | ${g.typecheck.failed} |`);
    if (g.unit) lines.push(`| unit | ${g.unit.passed} | ${g.unit.failed} |`);
  }

  // Defensive: artifact:// URIs must NEVER appear in the block.
  const rendered = lines.join('\n');
  if (ARTIFACT_URI_REGEX.test(rendered)) {
    throw new TraceabilityBlockError(
      'artifact:// URI leaked into traceability block',
      'rendered',
    );
  }
  return rendered;
}

/** Predicate used by tests and the renderer to keep artifact URIs out. */
export function containsArtifactUri(text: string): boolean {
  return ARTIFACT_URI_REGEX.test(text);
}

/**
 * Commit message renderer — T-M7-002, spec §12.8.
 *
 * Every cgao commit message carries a traceability trailer block so
 * the run/spec/plan/issue it belongs to is recoverable from git log
 * alone. The trailer block uses standard `Key: Value` format so it
 * plays nicely with `git log --format=%B` and tooling that parses
 * trailers.
 *
 * Contracts:
 *   - The summary line is the imperative subject (no trailing period).
 *   - The trailer block is appended after a blank line.
 *   - Trailer keys are stable: `Refs`, `Run-Id`, `Spec-Id`, `Plan-Id`.
 *   - Plan-Id carries the @sha binding: `Plan-Id: <planId>@<planSha>`.
 */

export interface CommitTraceabilityInput {
  /** Issue number (e.g. 42). */
  issueNumber: number;
  /** Workflow run id. */
  runId: string;
  /** Spec id (RequirementSpec). */
  specId: string;
  /** Plan id (ImplementationPlan). */
  planId: string;
  /** Plan sha (64-hex). */
  planSha: string;
}

export interface CommitMessageInput extends CommitTraceabilityInput {
  /** Imperative summary (e.g. "fix deploy script for prod region"). */
  summary: string;
  /** Optional body lines (already trusted — never raw user content). */
  body?: readonly string[];
}

/** Header ceiling from commitlint config; we keep summary shorter. */
const MAX_SUMMARY_LEN = 72;

export class CommitMessageError extends Error {
  constructor(
    message: string,
    readonly field: string,
  ) {
    super(message);
    this.name = 'CommitMessageError';
  }
}

/**
 * Render the trailer block. Used both by the renderer and by tests
 * that grep for individual trailers.
 */
export function renderCommitTrailers(input: CommitTraceabilityInput): string {
  if (!/^[0-9a-f]{64}$/u.test(input.planSha)) {
    throw new CommitMessageError('planSha must be 64 hex chars', 'planSha');
  }
  return [
    `Refs: issue #${input.issueNumber}, run-id ${input.runId}`,
    `Spec-Id: ${input.specId}`,
    `Plan-Id: ${input.planId}@${input.planSha}`,
  ].join('\n');
}

/**
 * Render the full commit message:
 *
 *   <summary>
 *
 *   <optional body lines>
 *
 *   Refs: issue #<n>, run-id <runId>
 *   Spec-Id: <specId>
 *   Plan-Id: <planId>@<planSha>
 */
export function renderCommitMessage(input: CommitMessageInput): string {
  const summary = input.summary.trim();
  if (summary.length === 0) {
    throw new CommitMessageError('summary must be non-empty', 'summary');
  }
  if (summary.length > MAX_SUMMARY_LEN) {
    throw new CommitMessageError(
      `summary exceeds ${MAX_SUMMARY_LEN} chars (got ${summary.length})`,
      'summary',
    );
  }
  // Defensive: no newlines in the summary — it must be a single line.
  if (summary.includes('\n')) {
    throw new CommitMessageError('summary must not contain newlines', 'summary');
  }

  const trailers = renderCommitTrailers(input);
  const parts: string[] = [summary, ''];
  if (input.body && input.body.length > 0) {
    parts.push(...input.body, '');
  }
  parts.push(trailers);
  return parts.join('\n');
}

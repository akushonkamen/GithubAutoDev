/**
 * Plan comment renderer + approval command hint — T-M4-005,
 * spec §12.5 + §14.2 + §14.3.
 *
 * cgao posts a single PLAN_READY issue comment that contains:
 *
 *   - A trusted summary of the plan (id, sha, task list, risk floor).
 *   - A verbatim `/approve-plan <plan_id>@<plan_sha>` approval hint
 *     that maintainers copy-paste into a fresh comment.
 *   - A status marker (so cgao can UPDATE the same comment in place
 *     instead of spamming new comments as the plan evolves).
 *
 * Contracts (spec §14.2, §14.3):
 *
 *   - The approval hint ALWAYS carries plan_id@plan_sha (never just
 *     plan_id). `ApprovalCommandHint` is the single source of truth.
 *   - The comment body carries the cgao status marker so the runner
 *     can find + update it (no flood of new comments).
 *   - The body is a trusted render — it never interpolates raw issue
 *     body content. Only cgao-authoritative fields are rendered.
 */

import { renderStatusCommentBody } from '../issues/status-comment.js';
import type { IssueStatus } from '../issues/triage.js';
import type { ImplementationPlan } from './implementation-plan.js';
import type { RequirementSpec } from './requirement-spec.js';
import type { RuleEvaluationResult } from './risk-classifier.js';

export interface ApprovalCommandHintInput {
  planId: string;
  planSha: string;
}

/**
 * Render the canonical `/approve-plan <plan_id>@<plan_sha>` hint.
 * This is the verbatim string the maintainer copies into a comment.
 */
export function renderApprovalCommandHint(input: ApprovalCommandHintInput): string {
  // Defensive — never emit a hint with empty/whitespace fields. The
  // caller is expected to validate via the schema first, but the hint
  // is the security boundary so we re-check here.
  if (!input.planId.trim() || !input.planSha.trim()) {
    throw new Error('ApprovalCommandHint: plan_id and plan_sha must be non-empty');
  }
  return `/approve-plan ${input.planId}@${input.planSha}`;
}

export interface PlanCommentRenderInput {
  /** The RequirementSpec the plan was generated from. */
  spec: RequirementSpec;
  /** The plan to render. */
  plan: ImplementationPlan;
  /** Deterministic risk evaluation for the plan's paths/deps. */
  deterministicRisk: RuleEvaluationResult;
  /** HMAC-authenticated status marker string for the workflow run. */
  statusMarker: string;
  /** Status to render (PLAN_READY, PLAN_REVISED, etc). */
  status: IssueStatus;
  /** Optional human-readable note appended to the body (trusted). */
  note?: string;
}

/**
 * Render the PLAN_READY issue-comment body. The body is fully trusted —
 * it only interpolates fields cgao itself authored.
 *
 * Layout (spec §14.2):
 *
 *   <!-- cgao:run_id=... state=PLAN_READY comment_role=status -->
 *   ## cgao plan ready
 *   summary line
 *   acceptance criteria → tasks table
 *   risk floor
 *   ## Approval
 *   To approve: paste this in a new comment:
 *   `/approve-plan <plan_id>@<plan_sha>`
 */
export function renderPlanCommentBody(input: PlanCommentRenderInput): string {
  const lines: string[] = [];
  lines.push(`## cgao plan ready (${input.plan.planId})`);
  lines.push('');
  lines.push(`- **Spec digest:** \`${input.spec.issueSnapshotSha.slice(0, 12)}\``);
  lines.push(`- **Plan digest:** \`${input.plan.planSha.slice(0, 12)}\``);
  lines.push(`- **Generation:** ${input.plan.generation}`);
  lines.push(`- **Summary:** ${input.spec.summary}`);
  lines.push('');

  lines.push('### Acceptance criteria → tasks');
  lines.push('');
  lines.push('| Criterion | Task | Agent | Model tier | Allowed paths |');
  lines.push('|---|---|---|---|---|');
  for (const [i, ac] of input.spec.acceptanceCriteria.entries()) {
    const cid = `ac-${i + 1}`;
    const tasksForAc = input.plan.tasks.filter((t) => t.satisfies.includes(cid));
    if (tasksForAc.length === 0) {
      lines.push(`| ${cid}: ${truncate(ac.description, 60)} | _unmapped_ | — | — | — |`);
      continue;
    }
    for (const t of tasksForAc) {
      lines.push(
        `| ${cid}: ${truncate(ac.description, 60)} | ${t.id}: ${truncate(
          t.description,
          40,
        )} | ${t.agent} | ${t.modelTier} | ${truncate(t.allowedPaths.join(', '), 60)} |`,
      );
    }
  }
  lines.push('');

  lines.push('### Risk floor (deterministic, cannot be lowered by LLM)');
  lines.push('');
  lines.push(`- **Path severity:** \`${input.deterministicRisk.pathSeverity}\``);
  lines.push(`- **Dependency severity:** \`${input.deterministicRisk.dependencySeverity}\``);
  lines.push(`- **Combined:** \`${input.deterministicRisk.severity}\``);
  if (input.deterministicRisk.matches.length > 0) {
    lines.push('- **Matched rules:**');
    for (const m of input.deterministicRisk.matches) {
      lines.push(`  - \`${m.pattern}\` (${m.bucket}) → ${m.severity}`);
    }
  } else {
    lines.push('- No protected-path matches.');
  }
  lines.push('');

  lines.push('## Approval');
  lines.push('');
  lines.push('To approve, paste this in a **new** comment:');
  lines.push('');
  lines.push('```text');
  lines.push(
    renderApprovalCommandHint({
      planId: input.plan.planId,
      planSha: input.plan.planSha,
    }),
  );
  lines.push('```');
  lines.push('');

  if (input.note) {
    lines.push(input.note);
    lines.push('');
  }

  // Status marker goes LAST so the status-comment renderer can split it
  // back out when updating. renderStatusCommentBody wraps the body in
  // the marker envelope.
  return renderStatusCommentBody({
    marker: input.statusMarker,
    status: input.status,
    note: lines.join('\n').trimEnd(),
  });
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

/**
 * Parse an `/approve-plan <plan_id>@<plan_sha>` command from a comment
 * body. Returns null when the comment is not an approval command. Used
 * by the command parser (T-M3-004) — exposed here so the renderer +
 * parser share one regex.
 */
export const APPROVAL_COMMAND_REGEX = /^\/approve-plan\s+([A-Za-z0-9._-]+)@([0-9a-f]{64})\s*$/u;

export interface ParsedApprovalCommand {
  planId: string;
  planSha: string;
}

export function parseApprovalCommand(line: string): ParsedApprovalCommand | null {
  const m = APPROVAL_COMMAND_REGEX.exec(line.trim());
  if (!m) return null;
  const planId = m[1];
  const planSha = m[2];
  if (!planId || !planSha) return null;
  return { planId, planSha };
}

/**
 * Render a status-only UPDATE body (no approval hint, no plan table).
 * Used by the runner when transitioning states (e.g. PLAN_READY →
 * RUNNING) to update the same comment without re-rendering the plan.
 *
 * This is the "no flood" path: the runner locates the existing cgao
 * status comment by marker and overwrites its body with this render.
 */
export function renderStatusUpdateBody(args: {
  marker: string;
  status: IssueStatus;
  message: string;
}): string {
  return renderStatusCommentBody({
    marker: args.marker,
    status: args.status,
    note: args.message,
  });
}

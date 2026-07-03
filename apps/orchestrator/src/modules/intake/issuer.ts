/**
 * Intake IssueCreator — T-INTAKE-008, spec §12.0 / §13.1 / §17.4 / §17.5.
 *
 * The intake module does NOT call GitHub directly. When a session
 * reaches `ready`, the orchestrator calls IssueCreator.request() to
 * publish an `intake.issue.create_requested` CloudEvent. A Trusted
 * Control Runner job consumes that event and performs the actual
 * GitHub API call (cgao-intake-issue-create.yml).
 *
 * This separation keeps GitHub credentials out of the intake
 * orchestrator (spec §17.4 / §17.5 — secrets only on Trusted Control
 * Runner) and gives us one authoritative chokepoint for issue
 * creation audit.
 *
 * The issue body MUST contain cgao metadata + classification_hint as
 * advisory fields. The Trusted Control Runner sets only cgao:new +
 * intake:im labels (no authoritative bug/feature/security).
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '@cgao/eventbus';
import type { ClassificationHint } from './classifier.js';

export interface IntakeIssueCreateRequest {
  repo: string;
  intakeSessionId: string;
  source: {
    type: 'lark' | 'wecom' | 'github_issue' | 'github_discussion';
    externalId: string;
    /** Stable display name of the user as the IM platform reported it. */
    senderDisplayName: string;
    /** GitHub login if we've already mapped this sender to one; else null. */
    senderGithubLogin: string | null;
  };
  /** The clarified summary that should appear at the top of the issue. */
  summary: string;
  /** The user-visible transcript the clarifier collected (advisory). */
  transcriptSummary: string;
  /** LLM-derived hints; advisory only — never authoritative labels. */
  classificationHint: ClassificationHint;
  dedupKey: string;
}

export interface IssueCreateRequestedEnvelope {
  specversion: '1.0';
  id: string;
  source: string;
  type: 'intake.issue.create_requested';
  subject: string;
  time: string;
  datacontenttype: 'application/json';
  data: {
    repo: string;
    intake_session_id: string;
    source: {
      type: IntakeIssueCreateRequest['source']['type'];
      external_id: string;
      sender_display_name: string;
      sender_github_login: string | null;
    };
    summary: string;
    transcript_summary: string;
    classification_hint: {
      confidence: number;
      category_hint: ClassificationHint['categoryHint'];
      severity_hint: ClassificationHint['severityHint'];
      injection_suspected: boolean;
    };
    dedup_key: string;
  };
}

export interface IssueCreator {
  request(input: IntakeIssueCreateRequest, now?: Date): Promise<IssueCreateRequestedEnvelope>;
}

export const ISSUE_CREATE_TOPIC = 'intake.issue.create_requested';

export class IntakeIssueCreator implements IssueCreator {
  constructor(
    private readonly bus: EventBus,
    private readonly origin: string = 'cgao.intake',
  ) {}

  async request(
    input: IntakeIssueCreateRequest,
    now: Date = new Date(),
  ): Promise<IssueCreateRequestedEnvelope> {
    // Defense-in-depth: never pass injection-suspected content through
    // without an explicit flag. The Trusted Control Runner re-scans
    // before posting; if injection_suspected=true it MUST refuse to
    // create the issue and surface a handoff message.
    const envelope: IssueCreateRequestedEnvelope = {
      specversion: '1.0',
      id: randomUUID(),
      source: this.origin,
      type: ISSUE_CREATE_TOPIC,
      subject: `${input.repo}/${input.intakeSessionId}`,
      time: now.toISOString(),
      datacontenttype: 'application/json',
      data: {
        repo: input.repo,
        intake_session_id: input.intakeSessionId,
        source: {
          type: input.source.type,
          external_id: input.source.externalId,
          sender_display_name: input.source.senderDisplayName,
          sender_github_login: input.source.senderGithubLogin,
        },
        summary: input.summary,
        transcript_summary: input.transcriptSummary,
        classification_hint: {
          confidence: input.classificationHint.confidence,
          category_hint: input.classificationHint.categoryHint,
          severity_hint: input.classificationHint.severityHint,
          injection_suspected: input.classificationHint.injectionSuspected,
        },
        dedup_key: input.dedupKey,
      },
    };
    await this.bus.publish({
      topic: ISSUE_CREATE_TOPIC,
      payload: envelope as unknown as Record<string, unknown>,
      traceId: input.intakeSessionId,
      // Intake creation is durable: must outlive a single orchestrator
      // restart. The eventbus default retry policy applies; the Trusted
      // Control Runner consumer MUST be idempotent on intake_session_id.
      headers: {
        'cgao-dedup-key': input.dedupKey,
        'cgao-intake-session-id': input.intakeSessionId,
      },
    });
    return envelope;
  }
}

/**
 * Build the GitHub issue body the Trusted Control Runner will post.
 * Pure function so it can be tested without an HTTP client.
 */
export function buildIssueBody(input: IntakeIssueCreateRequest): string {
  // NOTE: the body still has to be wrapped in the untrusted envelope when
  // interpolated into LLM contexts downstream — but for GitHub display
  // we render it as a normal issue. The classification_hint block is
  // marked as advisory and explicit.
  const senderLine = input.source.senderGithubLogin
    ? `@${input.source.senderGithubLogin}`
    : input.source.senderDisplayName;
  return [
    '## cgao intake (advisory classification)',
    '',
    '**Summary**',
    '',
    input.summary,
    '',
    `**Reported by** ${senderLine} (source: ${input.source.type})`,
    '',
    '<details><summary>Transcript</summary>',
    '',
    input.transcriptSummary || '(no transcript captured)',
    '',
    '</details>',
    '',
    '<details><summary>cgao metadata</summary>',
    '',
    `- intake_session_id: \`${input.intakeSessionId}\``,
    `- source_type: \`${input.source.type}\``,
    `- external_id: \`${input.source.externalId}\``,
    `- dedup_key: \`${input.dedupKey}\``,
    `- classification_hint.category: \`${input.classificationHint.categoryHint}\``,
    `- classification_hint.severity: \`${input.classificationHint.severityHint}\``,
    `- classification_hint.confidence: \`${input.classificationHint.confidence.toFixed(3)}\``,
    '',
    '</details>',
  ].join('\n');
}

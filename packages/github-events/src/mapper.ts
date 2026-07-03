/**
 * GitHub payload → CloudEvents-style envelope mapper (T-M1-003, spec §10).
 *
 * Topic naming follows spec §10: `<source>.<event_type>`.
 * Each envelope carries:
 *   - source: 'github'
 *   - type:   GitHub event/action pair (e.g. 'issues.opened')
 *   - subject: stable id (delivery UUID or content-derived)
 *   - trace_id: webhook delivery id for end-to-end correlation
 *   - data:    parsed payload
 *   - origin:  'external' by default — origin suppression (T-M1-004)
 *              may rewrite this to 'cgao' for self-echo events.
 */

import {
  issueCommentCreatedSchema,
  issueOpenedSchema,
  issuesLabeledSchema,
  pullRequestSynchronizeSchema,
  workflowRunCompletedSchema,
} from './schemas.js';

export interface GithubWebhookHeaders {
  'x-github-event': string;
  'x-github-delivery': string;
  'x-hub-signature-256': string;
}

export interface CloudEventEnvelope<T = unknown> {
  id: string;
  source: 'github';
  type: string;
  subject: string;
  traceId: string;
  time: string;
  datacontenttype: 'application/json';
  data: T;
  origin: 'external' | 'cgao';
  repo: string;
  headers: Record<string, string>;
}

export class UnsupportedEventTypeError extends Error {
  readonly eventType: string;
  readonly action: string | null;
  constructor(eventType: string, action: string | null) {
    super(`unsupported github event: ${eventType}${action ? `.action=${action}` : ''}`);
    this.name = 'UnsupportedEventTypeError';
    this.eventType = eventType;
    this.action = action;
  }
}

type Mapper = (payload: unknown) => { type: string; data: unknown; subject: string; repo: string };

const MAPPERS: Record<string, Mapper> = {
  issues: (raw) => {
    const parsed = issueOpenedSchema.safeParse(raw);
    if (parsed.success) {
      const d = parsed.data;
      return {
        type: 'issues.opened',
        data: d,
        subject: `${d.repository.full_name}#issue-${d.issue.number}`,
        repo: d.repository.full_name,
      };
    }
    const labeled = issuesLabeledSchema.safeParse(raw);
    if (labeled.success) {
      const d = labeled.data;
      return {
        type: 'issues.labeled',
        data: d,
        subject: `${d.repository.full_name}#issue-${d.issue.number}`,
        repo: d.repository.full_name,
      };
    }
    throw new UnsupportedEventTypeError('issues', (raw as { action?: string }).action ?? null);
  },
  issue_comment: (raw) => {
    const d = issueCommentCreatedSchema.parse(raw);
    return {
      type: 'issue_comment.created',
      data: d,
      subject: `${d.repository.full_name}#comment-${d.comment.id}`,
      repo: d.repository.full_name,
    };
  },
  pull_request: (raw) => {
    const action = (raw as { action?: string }).action;
    if (action === 'synchronize') {
      const d = pullRequestSynchronizeSchema.parse(raw);
      return {
        type: 'pull_request.synchronize',
        data: d,
        subject: `${d.repository.full_name}#pr-${d.number}@${d.pull_request.head.sha}`,
        repo: d.repository.full_name,
      };
    }
    throw new UnsupportedEventTypeError('pull_request', action ?? null);
  },
  workflow_run: (raw) => {
    const d = workflowRunCompletedSchema.parse(raw);
    return {
      type: 'workflow_run.completed',
      data: d,
      subject: `${d.repository.full_name}#run-${d.workflow_run.id}`,
      repo: d.repository.full_name,
    };
  },
};

export function mapGithubEvent(
  headers: GithubWebhookHeaders,
  rawPayload: unknown,
  receivedAt: Date = new Date(),
): CloudEventEnvelope {
  const eventType = headers['x-github-event'];
  const mapper = MAPPERS[eventType];
  if (!mapper) throw new UnsupportedEventTypeError(eventType, null);
  const mapped = mapper(rawPayload);
  return {
    id: headers['x-github-delivery'],
    source: 'github',
    type: mapped.type,
    subject: mapped.subject,
    traceId: headers['x-github-delivery'],
    time: receivedAt.toISOString(),
    datacontenttype: 'application/json',
    data: mapped.data,
    origin: 'external',
    repo: mapped.repo,
    headers: { ...headers },
  };
}

/**
 * IssueCreator + issue body builder — T-INTAKE-008.
 */

import { InMemoryEventBus } from '@cgao/eventbus';
import { describe, expect, it } from 'vitest';
import {
  ISSUE_CREATE_TOPIC,
  type IntakeIssueCreateRequest,
  IntakeIssueCreator,
  buildIssueBody,
} from '../issuer.js';

function mkRequest(overrides: Partial<IntakeIssueCreateRequest> = {}): IntakeIssueCreateRequest {
  return {
    repo: 'owner/name',
    intakeSessionId: 'sess-1',
    source: {
      type: 'lark',
      externalId: 'chat1:msg1',
      senderDisplayName: 'alice',
      senderGithubLogin: null,
    },
    summary: 'Deploy failed at 3am, postgres connection refused.',
    transcriptSummary: 'USER: deploy broken',
    classificationHint: {
      confidence: 0.85,
      categoryHint: 'incident',
      severityHint: 'high',
      injectionSuspected: false,
    },
    dedupKey: 'lark|chat1:msg1|abc',
    ...overrides,
  };
}

describe('IntakeIssueCreator.request (T-INTAKE-008)', () => {
  it('publishes an intake.issue.create_requested CloudEvent', async () => {
    const bus = new InMemoryEventBus();
    const creator = new IntakeIssueCreator(bus);
    const req = mkRequest();
    await creator.request(req);
    expect(bus.unread(ISSUE_CREATE_TOPIC)).toBe(1);
  });

  it('shapes the envelope with cgao metadata and advisory hint', async () => {
    const bus = new InMemoryEventBus();
    let captured: unknown = null;
    bus.subscribe(ISSUE_CREATE_TOPIC, async (msg) => {
      captured = msg.payload;
    });
    const creator = new IntakeIssueCreator(bus);
    const env = await creator.request(mkRequest());
    expect(captured).toEqual(env);
    expect(env.type).toBe('intake.issue.create_requested');
    expect(env.subject).toBe('owner/name/sess-1');
    expect(env.data.repo).toBe('owner/name');
    expect(env.data.intake_session_id).toBe('sess-1');
    expect(env.data.source.sender_github_login).toBeNull();
    expect(env.data.classification_hint.category_hint).toBe('incident');
    expect(env.data.classification_hint.injection_suspected).toBe(false);
    expect(env.data.dedup_key).toBe('lark|chat1:msg1|abc');
  });

  it('sets cgao-dedup-key and cgao-intake-session-id headers', async () => {
    const bus = new InMemoryEventBus();
    let headers: Record<string, string> = {};
    bus.subscribe(ISSUE_CREATE_TOPIC, async (msg) => {
      headers = msg.headers;
    });
    const creator = new IntakeIssueCreator(bus);
    await creator.request(mkRequest());
    expect(headers['cgao-dedup-key']).toBe('lark|chat1:msg1|abc');
    expect(headers['cgao-intake-session-id']).toBe('sess-1');
  });

  it('uses traceId = intake session id for downstream correlation', async () => {
    const bus = new InMemoryEventBus();
    let trace: string | null = null;
    bus.subscribe(ISSUE_CREATE_TOPIC, async (msg) => {
      trace = msg.traceId;
    });
    const creator = new IntakeIssueCreator(bus);
    await creator.request(mkRequest());
    expect(trace).toBe('sess-1');
  });
});

describe('buildIssueBody (T-INTAKE-008)', () => {
  it('renders summary, sender, transcript, and metadata block', () => {
    const body = buildIssueBody(mkRequest());
    expect(body).toContain('Deploy failed at 3am');
    expect(body).toContain('Reported by');
    expect(body).toContain('alice');
    expect(body).toContain('intake_session_id: `sess-1`');
    expect(body).toContain('classification_hint.category: `incident`');
    expect(body).toContain('classification_hint.confidence: `0.850`');
    expect(body).toContain('dedup_key: `lark|chat1:msg1|abc`');
  });

  it('prefers GitHub login over display name when present', () => {
    const body = buildIssueBody(
      mkRequest({
        source: {
          type: 'lark',
          externalId: 'm1',
          senderDisplayName: 'alice',
          senderGithubLogin: 'alice-dev',
        },
      }),
    );
    expect(body).toContain('@alice-dev');
    expect(body).not.toContain('Reported by alice\n');
  });

  it('marks the classification hint as advisory', () => {
    const body = buildIssueBody(mkRequest());
    expect(body.toLowerCase()).toContain('advisory');
  });
});

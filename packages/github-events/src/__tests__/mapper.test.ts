/**
 * GitHub → CloudEvents mapper regression — T-M1-003, spec §10.
 */

import { describe, expect, it } from 'vitest';
import { type CloudEventEnvelope, UnsupportedEventTypeError, mapGithubEvent } from '../index.js';

const HEADERS = {
  'x-github-event': 'issues',
  'x-github-delivery': 'd0e1f2a3-b4c5-6789-0abc-def123456789',
  'x-hub-signature-256': 'sha256=placeholder',
};

describe('mapGithubEvent', () => {
  it('maps issues.opened to a CloudEvents envelope with stable subject', () => {
    const env = mapGithubEvent(HEADERS, {
      action: 'opened',
      issue: {
        number: 7,
        title: 'x',
        body: 'y',
        html_url: 'https://github.com/cgao/test/issues/7',
      },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    });
    expect(env.type).toBe('issues.opened');
    expect(env.subject).toBe('cgao/test#issue-7');
    expect(env.traceId).toBe(HEADERS['x-github-delivery']);
    expect(env.origin).toBe('external');
    expect(env.repo).toBe('cgao/test');
  });

  it('maps issues.labeled', () => {
    const env = mapGithubEvent(HEADERS, {
      action: 'labeled',
      issue: { number: 7, title: 'x', html_url: 'https://github.com/cgao/test/issues/7' },
      label: { name: 'bug' },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    });
    expect(env.type).toBe('issues.labeled');
  });

  it('maps issue_comment.created', () => {
    const env = mapGithubEvent(
      { ...HEADERS, 'x-github-event': 'issue_comment' },
      {
        action: 'created',
        issue: { number: 7 },
        comment: { id: 999, body: 'hi', user: { login: 'alice' } },
        repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
      },
    );
    expect(env.type).toBe('issue_comment.created');
    expect(env.subject).toContain('comment-999');
  });

  it('maps pull_request.synchronize with head sha in subject', () => {
    const sha = 'a'.repeat(40);
    const env = mapGithubEvent(
      { ...HEADERS, 'x-github-event': 'pull_request' },
      {
        action: 'synchronize',
        number: 42,
        pull_request: { number: 42, head: { sha }, base: { sha: 'b'.repeat(40) } },
        repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
      },
    );
    expect(env.type).toBe('pull_request.synchronize');
    expect(env.subject).toContain(sha);
  });

  it('maps workflow_run.completed', () => {
    const env = mapGithubEvent(
      { ...HEADERS, 'x-github-event': 'workflow_run' },
      {
        action: 'completed',
        workflow_run: {
          id: 123,
          head_sha: 'a'.repeat(40),
          conclusion: 'success',
          html_url: 'https://github.com/cgao/test/actions/runs/123',
        },
        repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
      },
    );
    expect(env.type).toBe('workflow_run.completed');
  });

  it('throws UnsupportedEventTypeError for unknown event types', () => {
    expect(() => mapGithubEvent({ ...HEADERS, 'x-github-event': 'unknown_evt' }, {})).toThrow(
      UnsupportedEventTypeError,
    );
  });

  it('preserves the original headers on the envelope for traceability', () => {
    const env: CloudEventEnvelope = mapGithubEvent(HEADERS, {
      action: 'opened',
      issue: {
        number: 1,
        title: 't',
        body: null,
        html_url: 'https://github.com/cgao/test/issues/1',
      },
      repository: { name: 'test', full_name: 'cgao/test', owner: { login: 'cgao' } },
    });
    expect(env.headers['x-github-delivery']).toBe(HEADERS['x-github-delivery']);
  });
});

/**
 * Status comment manager — T-M3-002, spec §14.2.
 *
 * Locks the contracts:
 *   - At most one active status comment per run per issue.
 *   - Existing bot-authored comment gets edited; new ones only when
 *     none exists or the existing one wasn't authored by the bot.
 *   - Forged markers (constructed without the secret) cannot cause a
 *     status mutation — they fail HMAC verification.
 */

import { describe, expect, it } from 'vitest';
import {
  InMemoryStatusCommentRepository,
  type StatusCommentConfig,
  StatusCommentService,
  generateStatusMarker,
  parseStatusMarker,
  renderStatusCommentBody,
  verifyStatusMarker,
} from '../status-comment.js';

const config: StatusCommentConfig = {
  cgaoBotLogin: 'cgao-bot[bot]',
  markerSecret: 'control-token-secret',
};

describe('generateStatusMarker + parseStatusMarker (T-M3-002)', () => {
  it('round-trips runId, status, nonce, mac', () => {
    const marker = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 42,
      runId: 'run-1',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    const parsed = parseStatusMarker(marker);
    expect(parsed).not.toBeNull();
    expect(parsed?.runId).toBe('run-1');
    expect(parsed?.status).toBe('ready');
    expect(parsed?.nonce).toMatch(/^[0-9a-f-]{36}$/u);
    expect(parsed?.mac).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('two markers for the same inputs differ (nonce is random)', () => {
    const a = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    const b = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    expect(a).not.toBe(b);
  });

  it('parseStatusMarker returns null for a forged marker', () => {
    expect(parseStatusMarker('<!-- not a marker -->')).toBeNull();
    expect(parseStatusMarker('')).toBeNull();
    // Truncated marker missing mac:
    expect(
      parseStatusMarker('<!-- cgao:status-comment-marker run=r status=ready nonce=n -->'),
    ).toBeNull();
  });
});

describe('verifyStatusMarker (T-M3-002)', () => {
  it('verifies a marker minted with the same secret', () => {
    const marker = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 42,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    const parsed = parseStatusMarker(marker);
    expect(parsed).not.toBeNull();
    expect(
      verifyStatusMarker({
        secret: config.markerSecret,
        repo: 'cgao/test',
        issueNumber: 42,
        parsed: parsed ?? { runId: '', status: 'ready', nonce: '', mac: '' },
        authorLogin: config.cgaoBotLogin,
      }),
    ).toBe(true);
  });

  it('rejects a marker minted with a different secret', () => {
    const marker = generateStatusMarker({
      secret: 'wrong',
      repo: 'cgao/test',
      issueNumber: 42,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    const parsed = parseStatusMarker(marker);
    expect(parsed).not.toBeNull();
    expect(
      verifyStatusMarker({
        secret: config.markerSecret,
        repo: 'cgao/test',
        issueNumber: 42,
        parsed: parsed ?? { runId: '', status: 'ready', nonce: '', mac: '' },
        authorLogin: config.cgaoBotLogin,
      }),
    ).toBe(false);
  });

  it('rejects a marker minted for a different issue', () => {
    const marker = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 41,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'ready',
    });
    const parsed = parseStatusMarker(marker);
    expect(parsed).not.toBeNull();
    expect(
      verifyStatusMarker({
        secret: config.markerSecret,
        repo: 'cgao/test',
        issueNumber: 42,
        parsed: parsed ?? { runId: '', status: 'ready', nonce: '', mac: '' },
        authorLogin: config.cgaoBotLogin,
      }),
    ).toBe(false);
  });
});

describe('renderStatusCommentBody (T-M3-002)', () => {
  it('includes status line and marker', () => {
    const marker = generateStatusMarker({
      secret: config.markerSecret,
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r',
      authorLogin: config.cgaoBotLogin,
      status: 'needs_info',
    });
    const body = renderStatusCommentBody({
      status: 'needs_info',
      category: 'bug',
      missingFields: ['steps_to_reproduce'],
      marker,
    });
    expect(body).toContain('Status:');
    expect(body).toContain('Kind:');
    expect(body).toContain('steps_to_reproduce');
    expect(body).toContain(marker);
  });
});

describe('StatusCommentService.upsert (T-M3-002)', () => {
  it('creates a new comment when none exists', async () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    const rec = await svc.upsert({
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r1',
      status: 'needs_info',
    });
    expect(rec.commentId).toBeGreaterThan(0);
    expect(rec.status).toBe('needs_info');
  });

  it('edits the existing comment on a subsequent upsert (same run, same issue)', async () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    const first = await svc.upsert({
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r1',
      status: 'needs_info',
    });
    const second = await svc.upsert({
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r1',
      status: 'ready',
    });
    expect(second.commentId).toBe(first.commentId);
    expect(second.status).toBe('ready');
  });

  it('does NOT edit a comment authored by a non-bot user', async () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    // A malicious user posts a comment with a forged marker, claiming
    // to be a cgao status comment.
    repo.injectForged({
      repo: 'cgao/test',
      issueNumber: 1,
      authorLogin: 'attacker',
      body: '<!-- cgao:status-comment-marker run=r status=approved nonce=n mac=deadbeef -->',
    });
    const rec = await svc.upsert({
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r1',
      status: 'needs_info',
    });
    // cgao creates a NEW comment rather than editing the attacker's.
    expect(rec.authorLogin).toBe(config.cgaoBotLogin);
    expect(rec.runId).toBe('r1');
  });
});

describe('StatusCommentService.isAuthenticated (T-M3-002)', () => {
  it('returns true for a body minted with the right secret', async () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    const rec = await svc.upsert({
      repo: 'cgao/test',
      issueNumber: 1,
      runId: 'r1',
      status: 'ready',
    });
    // Body is reconstructed from the rendered body — reconstruct:
    const body = renderStatusCommentBody({
      status: 'ready',
      marker: rec.marker,
    });
    expect(svc.isAuthenticated({ body, repo: 'cgao/test', issueNumber: 1 })).toBe(true);
  });

  it('returns false for a body with a forged marker', () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    const body = '<!-- cgao:status-comment-marker run=r status=approved nonce=n mac=deadbeef -->';
    expect(svc.isAuthenticated({ body, repo: 'cgao/test', issueNumber: 1 })).toBe(false);
  });

  it('returns false for a body with no marker at all', () => {
    const repo = new InMemoryStatusCommentRepository();
    const svc = new StatusCommentService(repo, config);
    expect(svc.isAuthenticated({ body: 'just a comment', repo: 'cgao/test', issueNumber: 1 })).toBe(
      false,
    );
  });
});

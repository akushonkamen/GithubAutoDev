/**
 * Command parser — T-M3-004, spec §12.3 + §14.3.
 *
 * Locks the contracts:
 *   - Only issue_comment.created is parsed; edited is rejected.
 *   - Unknown commands return ParseError{kind:'unknown_command'}.
 *   - Argument shape mismatch returns ParseError{kind:'bad_args'}.
 *   - Strong commands are flagged requiresAuthorization=true.
 */

import { describe, expect, it } from 'vitest';
import { type ParseCommentInput, STRONG_COMMANDS, parseComment } from '../parser.js';

function input(overrides: Partial<ParseCommentInput> = {}): ParseCommentInput {
  return {
    botLogin: 'cgao-bot',
    body: '',
    authorLogin: 'alice',
    eventType: 'issue_comment.created',
    ...overrides,
  };
}

describe('parseComment (T-M3-004) — issue_comment.created only', () => {
  it('parses a simple command from a created comment', () => {
    const r = parseComment(input({ body: '@cgao-bot status' }));
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;
    expect(r.commands).toHaveLength(1);
    expect(r.commands[0]?.name).toBe('status');
    expect(r.commands[0]?.line).toBe(1);
  });

  it('rejects issue_comment.edited (no commands emitted)', () => {
    const r = parseComment(
      input({ body: '@cgao-bot approve-plan abc@12345678', eventType: 'issue_comment.edited' }),
    );
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('edited_event_rejected');
  });

  it('rejects unknown event types entirely', () => {
    const r = parseComment(input({ body: '@cgao-bot status', eventType: 'issue_comment.deleted' }));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('edited_event_rejected');
  });
});

describe('parseComment (T-M3-004) — unknown commands', () => {
  it('returns unknown_command for an unrecognized verb', () => {
    const r = parseComment(input({ body: '@cgao-bot do-the-thing' }));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('unknown_command');
    expect(r.line).toBe(1);
  });
});

describe('parseComment (T-M3-004) — argument shape', () => {
  it('approve-plan requires a single plan_id@sha argument', () => {
    const ok = parseComment(input({ body: '@cgao-bot approve-plan myplan@abcd1234' }));
    expect(ok.kind).toBe('success');

    const bad = parseComment(input({ body: '@cgao-bot approve-plan' }));
    expect(bad.kind).toBe('error');
    if (bad.kind !== 'error') return;
    expect(bad.reason).toBe('bad_args');
  });

  it('approve-plan rejects a missing sha', () => {
    const bad = parseComment(input({ body: '@cgao-bot approve-plan myplan' }));
    expect(bad.kind).toBe('error');
    if (bad.kind !== 'error') return;
    expect(bad.reason).toBe('bad_args');
  });

  it('answer requires at least one word', () => {
    const bad = parseComment(input({ body: '@cgao-bot answer' }));
    expect(bad.kind).toBe('error');
    if (bad.kind !== 'error') return;
    expect(bad.reason).toBe('bad_args');
  });

  it('label requires at least one label name', () => {
    const ok = parseComment(input({ body: '@cgao-bot label priority:high' }));
    expect(ok.kind).toBe('success');
    const bad = parseComment(input({ body: '@cgao-bot label' }));
    expect(bad.kind).toBe('error');
  });
});

describe('parseComment (T-M3-004) — multiple commands per comment', () => {
  it('parses multiple commands across multiple lines', () => {
    const body = ['@cgao-bot status', '@cgao-bot assign @alice', '@cgao-bot retry'].join('\n');
    const r = parseComment(input({ body }));
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;
    expect(r.commands.map((c) => c.name)).toEqual(['status', 'assign', 'retry']);
    expect(r.commands[1]?.line).toBe(2);
  });

  it('stops at the first malformed line', () => {
    const body = ['@cgao-bot status', '@cgao-bot bogus-cmd', '@cgao-bot retry'].join('\n');
    const r = parseComment(input({ body }));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('unknown_command');
    expect(r.line).toBe(2);
  });
});

describe('parseComment (T-M3-004) — strong commands', () => {
  it('flags approve-plan as requiring authorization', () => {
    const r = parseComment(input({ body: '@cgao-bot approve-plan myplan@abcd1234' }));
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') return;
    expect(r.commands[0]?.requiresAuthorization).toBe(true);
  });

  it('flags cancel-run, merge-pr, close, abort as strong', () => {
    for (const name of ['cancel-run', 'merge-pr', 'close', 'abort']) {
      const body =
        name === 'merge-pr'
          ? '@cgao-bot merge-pr'
          : name === 'cancel-run'
            ? '@cgao-bot cancel-run run-1'
            : name === 'abort'
              ? '@cgao-bot abort'
              : '@cgao-bot close';
      const r = parseComment(input({ body }));
      expect(r.kind).toBe('success');
      if (r.kind !== 'success') return;
      expect(r.commands[0]?.requiresAuthorization, `cmd=${name}`).toBe(true);
    }
  });

  it('does NOT flag status/plan/help/answer as strong', () => {
    for (const name of ['status', 'help', 'answer']) {
      const body = name === 'answer' ? '@cgao-bot answer yes' : `@cgao-bot ${name}`;
      const r = parseComment(input({ body }));
      expect(r.kind).toBe('success');
      if (r.kind !== 'success') return;
      expect(r.commands[0]?.requiresAuthorization, `cmd=${name}`).toBe(false);
    }
  });

  it('STRONG_COMMANDS set matches the documented list', () => {
    expect([...STRONG_COMMANDS].sort()).toEqual([
      'abort',
      'approve-plan',
      'cancel-plan',
      'cancel-run',
      'close',
      'merge-pr',
    ]);
  });
});

describe('parseComment (T-M3-004) — no bot mention', () => {
  it('returns no_bot_mention when the body never mentions the bot', () => {
    const r = parseComment(input({ body: 'just chatting about cgao' }));
    expect(r.kind).toBe('error');
    if (r.kind !== 'error') return;
    expect(r.reason).toBe('no_bot_mention');
  });

  it('mention regex matches case-insensitively', () => {
    const r = parseComment(input({ body: '@CGAO-BOT status' }));
    expect(r.kind).toBe('success');
  });

  it('mention requires @ or exact handle match', () => {
    const r = parseComment(input({ body: 'hey cgao-bot status' }));
    expect(r.kind).toBe('error');
  });
});

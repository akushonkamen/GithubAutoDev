/**
 * Commit message renderer — T-M7-002, spec §12.8.
 *
 * Locks the contracts:
 *   - summary line is imperative, single-line, ≤72 chars.
 *   - trailer block carries issue, run_id, spec_id, plan_id@plan_sha.
 *   - body, when present, sits between summary and trailers.
 *   - bad inputs (empty summary, multi-line summary, bad planSha) throw.
 */

import { describe, expect, it } from 'vitest';
import {
  CommitMessageError,
  renderCommitMessage,
  renderCommitTrailers,
} from '../commit-message-renderer.js';

const baseInput = {
  issueNumber: 42,
  runId: 'run_abc',
  specId: 'spec-0001',
  planId: 'plan-0001',
  planSha: 'a'.repeat(64),
};

describe('renderCommitTrailers (T-M7-002, spec §12.8)', () => {
  it('emits the traceability trailers in stable order', () => {
    const t = renderCommitTrailers(baseInput);
    expect(t).toContain('Refs: issue #42, run-id run_abc');
    expect(t).toContain('Spec-Id: spec-0001');
    expect(t).toContain(`Plan-Id: plan-0001@${'a'.repeat(64)}`);
    // Order: Refs, Spec-Id, Plan-Id
    expect(t.split('\n')).toEqual([
      'Refs: issue #42, run-id run_abc',
      'Spec-Id: spec-0001',
      `Plan-Id: plan-0001@${'a'.repeat(64)}`,
    ]);
  });

  it('rejects a planSha that is not 64 hex chars', () => {
    expect(() => renderCommitTrailers({ ...baseInput, planSha: 'short' })).toThrow(
      CommitMessageError,
    );
  });
});

describe('renderCommitMessage (T-M7-002)', () => {
  it('renders summary + blank + trailers', () => {
    const msg = renderCommitMessage({ ...baseInput, summary: 'fix deploy script' });
    expect(msg).toBe(
      [
        'fix deploy script',
        '',
        'Refs: issue #42, run-id run_abc',
        'Spec-Id: spec-0001',
        `Plan-Id: plan-0001@${'a'.repeat(64)}`,
      ].join('\n'),
    );
  });

  it('renders summary + body + trailers when body is provided', () => {
    const msg = renderCommitMessage({
      ...baseInput,
      summary: 'fix deploy script',
      body: ['Switches the deploy runner to use the prod region.', 'Updates docs.'],
    });
    expect(msg).toContain('Switches the deploy runner to use the prod region.');
    // Body must appear between summary and trailers.
    const idxSummary = msg.indexOf('fix deploy script');
    const idxBody = msg.indexOf('Switches the deploy');
    const idxTrailer = msg.indexOf('Refs:');
    expect(idxSummary).toBeLessThan(idxBody);
    expect(idxBody).toBeLessThan(idxTrailer);
  });

  it('contains every traceability field verbatim', () => {
    const msg = renderCommitMessage({ ...baseInput, summary: 'x' });
    expect(msg).toContain('issue #42');
    expect(msg).toContain('run-id run_abc');
    expect(msg).toContain('Spec-Id: spec-0001');
    expect(msg).toContain('Plan-Id: plan-0001@');
    expect(msg).toContain('a'.repeat(64));
  });

  it('rejects empty summary', () => {
    expect(() => renderCommitMessage({ ...baseInput, summary: '   ' })).toThrow(CommitMessageError);
  });

  it('rejects summary with embedded newlines', () => {
    expect(() => renderCommitMessage({ ...baseInput, summary: 'a\nb' })).toThrow(
      CommitMessageError,
    );
  });

  it('rejects summary longer than 72 chars', () => {
    const long = 'a'.repeat(73);
    expect(() => renderCommitMessage({ ...baseInput, summary: long })).toThrow(CommitMessageError);
  });
});

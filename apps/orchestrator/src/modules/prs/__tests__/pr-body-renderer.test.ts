/**
 * PR body renderer + traceability block — T-M7-004, spec §12.8 / §14.2.
 *
 * Locks the contracts:
 *   - body contains issue URL, run_id, spec_id, plan_id@plan_sha,
 *     head_sha, base_sha, and the gate summary.
 *   - body NEVER contains an `artifact://` URI (regex assert).
 *   - body is wrappable through the untrusted envelope for LLM use.
 *   - bad inputs (empty summary, short shas) throw.
 */

import { describe, expect, it } from 'vitest';
import { renderPrBody, wrapPrBodyForLlm } from '../pr-body-renderer.js';
import {
  TraceabilityBlockError,
  containsArtifactUri,
  renderTraceabilityBlock,
} from '../traceability-block.js';

const sha = 'a'.repeat(64);

const baseBlockInput = {
  issueNumber: 42,
  repo: 'cgao/test',
  runId: 'run_1',
  specId: 'spec-0001',
  planId: 'plan-0001',
  planSha: sha,
  headSha: sha,
  baseSha: sha,
};

describe('renderTraceabilityBlock (T-M7-004, spec §14.2)', () => {
  it('contains every traceability field', () => {
    const b = renderTraceabilityBlock(baseBlockInput);
    expect(b).toContain('cgao traceability');
    // Issue URL points to the github.com owner/name/issues/n form.
    expect(b).toContain('https://github.com/cgao/test/issues/42');
    expect(b).toContain('`run_1`');
    expect(b).toContain('`spec-0001`');
    expect(b).toContain('`plan-0001@');
    expect(b).toContain(sha.slice(0, 12));
    expect(b).toContain('| Head |');
    expect(b).toContain('| Base |');
  });

  it('includes the gate summary table when provided', () => {
    const b = renderTraceabilityBlock({
      ...baseBlockInput,
      gateSummary: {
        lint: { passed: 5, failed: 0 },
        typecheck: { passed: 12, failed: 0 },
        unit: { passed: 30, failed: 1 },
      },
    });
    expect(b).toContain('Gate summary');
    expect(b).toContain('| lint | 5 | 0 |');
    expect(b).toContain('| typecheck | 12 | 0 |');
    expect(b).toContain('| unit | 30 | 1 |');
  });

  it('omits the gate summary section when not provided', () => {
    const b = renderTraceabilityBlock(baseBlockInput);
    expect(b).not.toContain('Gate summary');
  });

  it('rejects bad shas', () => {
    expect(() => renderTraceabilityBlock({ ...baseBlockInput, planSha: 'short' })).toThrow(
      TraceabilityBlockError,
    );
    expect(() => renderTraceabilityBlock({ ...baseBlockInput, headSha: 'x' })).toThrow(
      TraceabilityBlockError,
    );
    expect(() => renderTraceabilityBlock({ ...baseBlockInput, baseSha: '' })).toThrow(
      TraceabilityBlockError,
    );
  });

  it('rejects a non-positive issue number', () => {
    expect(() => renderTraceabilityBlock({ ...baseBlockInput, issueNumber: 0 })).toThrow(
      TraceabilityBlockError,
    );
  });

  it('contains no artifact:// URI', () => {
    const b = renderTraceabilityBlock(baseBlockInput);
    expect(containsArtifactUri(b)).toBe(false);
  });

  it('detects artifact:// URIs via the predicate', () => {
    expect(containsArtifactUri('foo artifact://plan/abc bar')).toBe(true);
  });
});

describe('renderPrBody (T-M7-004)', () => {
  it('renders the full body with summary + traceability + footer', () => {
    const body = renderPrBody({
      ...baseBlockInput,
      summary: 'fix deploy script',
      gateSummary: { unit: { passed: 8, failed: 0 } },
    });
    expect(body).toContain('## cgao: fix deploy script');
    expect(body).toContain('cgao traceability');
    expect(body).toContain('https://github.com/cgao/test/issues/42');
    expect(body).toContain('run_1');
    expect(body).toContain('spec-0001');
    expect(body).toContain('plan-0001@');
    expect(body).toContain('| unit | 8 | 0 |');
    expect(body).toContain('cgao authored this PR');
  });

  it('does not expose artifact:// URIs anywhere in the body', () => {
    const body = renderPrBody({ ...baseBlockInput, summary: 'x' });
    expect(containsArtifactUri(body)).toBe(false);
    // Regex belt-and-suspenders: scan every line.
    expect(body.match(/\bartifact:\/\/\S+/u)).toBeNull();
  });

  it('rejects empty summary', () => {
    expect(() => renderPrBody({ ...baseBlockInput, summary: '  ' })).toThrow();
  });

  it('wrapPrBodyForLlm wraps the body in the untrusted envelope', () => {
    const body = renderPrBody({ ...baseBlockInput, summary: 'x' });
    const { raw, wrapped } = wrapPrBodyForLlm(body);
    expect(raw).toBe(body);
    expect(wrapped).toContain('<<<UNTRUSTED_CONTENT BEGIN>>>');
    expect(wrapped).toContain('<<<UNTRUSTED_CONTENT END>>>');
    expect(wrapped).toContain(body);
  });
});

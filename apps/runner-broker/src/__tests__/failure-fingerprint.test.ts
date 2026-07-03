/**
 * T-M6-002 failure parser + FingerprintService regression.
 *
 * Contracts (spec §12.7 / §20):
 *   - same logical failure yields same fingerprint across runs
 *   - line numbers do NOT change the fingerprint when error+file+rule match
 *   - parseFailures extracts structured spans for TS / ESLint / jest
 */

import { describe, expect, it } from 'vitest';
import { type FailureSpan, normalizeMessage, parseFailures } from '../gate/failure-parser.js';
import { FingerprintService, normalizeFilePath } from '../gate/fingerprint.js';

const FP = new FingerprintService();

describe('T-M6-002 FingerprintService', () => {
  it('returns the same digest for identical failure spans', () => {
    const span: FailureSpan = {
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 12,
      rule: 'TS2322',
      messageTemplate: "Type 'string' is not assignable to type 'number'",
    };
    const a = FP.fingerprint(span);
    const b = FP.fingerprint({ ...span });
    expect(a).toEqual(b);
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('ignores line numbers when computing the fingerprint', () => {
    const atLine1 = FP.fingerprint({
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 1,
      rule: 'TS2322',
      messageTemplate: "Type 'string' is not assignable to type 'number'",
    });
    const atLine99 = FP.fingerprint({
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 99,
      rule: 'TS2322',
      messageTemplate: "Type 'string' is not assignable to type 'number'",
    });
    expect(atLine1).toEqual(atLine99);
  });

  it('produces a different digest when the rule changes', () => {
    const ts2322 = FP.fingerprint({
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 1,
      rule: 'TS2322',
      messageTemplate: 'some message',
    });
    const ts7006 = FP.fingerprint({
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 1,
      rule: 'TS7006',
      messageTemplate: 'some message',
    });
    expect(ts2322).not.toEqual(ts7006);
  });

  it('normalizes file paths so "./src/a.ts" and "src/a.ts" collide', () => {
    const dot = FP.fingerprint({
      tool: 'lint',
      filePath: './src/a.ts',
      line: null,
      rule: 'no-unused-vars',
      messageTemplate: "'x' is defined but never used",
    });
    const bare = FP.fingerprint({
      tool: 'lint',
      filePath: 'src/a.ts',
      line: null,
      rule: 'no-unused-vars',
      messageTemplate: "'x' is defined but never used",
    });
    expect(dot).toEqual(bare);
  });
});

describe('T-M6-002 parseFailures', () => {
  it('extracts structured spans from TypeScript output', () => {
    const log = [
      'compiling...',
      "src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.",
      'compilation failed',
    ].join('\n');
    const spans = parseFailures(log, 'typecheck');
    expect(spans.length).toBeGreaterThan(0);
    const ts = spans.find((s) => s.rule === 'TS2322');
    expect(ts).toBeDefined();
    expect(ts?.filePath).toBe('src/a.ts');
    expect(ts?.line).toBe(12);
    // Fingerprint is stable for the parsed span.
    const fp1 = FP.fingerprint(ts as FailureSpan);
    const fp2 = FP.fingerprint({
      tool: 'typecheck',
      filePath: 'src/a.ts',
      line: 999,
      rule: 'TS2322',
      messageTemplate: ts?.messageTemplate as string,
    });
    expect(fp1).toEqual(fp2);
  });

  it('extracts FAIL lines from jest/vitest output', () => {
    const log = ['PASS src/a.test.ts', 'FAIL src/b.test.ts', 'tests: 1 failed'].join('\n');
    const spans = parseFailures(log, 'unit');
    const fail = spans.find((s) => s.messageTemplate === 'FAIL');
    expect(fail?.filePath).toBe('src/b.test.ts');
  });

  it('same log parsed twice produces identical fingerprints', () => {
    const log = "src/x.ts(1,1): error TS7006: Parameter 'a' implicitly has an 'any' type.";
    const a = parseFailures(log, 'typecheck');
    const b = parseFailures(log, 'typecheck');
    expect(a.length).toBe(b.length);
    for (let i = 0; i < a.length; i++) {
      expect(FP.fingerprint(a[i] as FailureSpan)).toEqual(FP.fingerprint(b[i] as FailureSpan));
    }
  });
});

describe('T-M6-002 normalizeMessage', () => {
  it('strips numbers and quoted content', () => {
    expect(normalizeMessage("expected 5 to equal '5' at line 12")).toBe(
      "expected <n> to equal '' at line <n>",
    );
  });
});

describe('T-M6-002 normalizeFilePath', () => {
  it('strips trailing :line:col annotations', () => {
    expect(normalizeFilePath('src/a.test.ts:12:3')).toBe('src/a.test.ts');
    expect(normalizeFilePath('src/a.test.ts:12')).toBe('src/a.test.ts');
  });

  it('normalizes backslashes', () => {
    expect(normalizeFilePath('src\\a.ts')).toBe('src/a.ts');
  });
});

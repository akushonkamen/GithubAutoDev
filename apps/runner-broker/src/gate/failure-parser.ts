/**
 * Failure parser — T-M6-002, spec §12.7 / §20.
 *
 * Extracts structured `FailureSpan` records from raw build / test /
 * lint output. Each span carries the minimal stable fields needed for
 * fingerprinting:
 *
 *   - tool: which adapter produced the log ('lint' | 'typecheck' | 'unit')
 *   - filePath: repo-relative path, when parseable (else null)
 *   - rule: rule / error code (e.g. `TS2322`, `no-unused-vars`), else null
 *   - messageTemplate: the message with numbers/identifiers normalized
 *     out so the same logical error yields the same fingerprint even
 *     when line numbers differ.
 *
 * The parser is intentionally lossy — its only job is to feed the
 * fingerprinter. Unparseable lines fall through with `tool` set and
 * everything else null so the fingerprint still summarizes them.
 */

import type { GateName } from './types.js';

export interface FailureSpan {
  tool: GateName | string;
  filePath: string | null;
  /** 1-based line number when parseable; excluded from fingerprint. */
  line: number | null;
  rule: string | null;
  messageTemplate: string;
}

/**
 * Parse a log into failure spans. Recognizes:
 *
 *   - TypeScript: `path(line,col): error TSxxxx: message`
 *   - ESLint:     `path:line:col: rule  message`
 *   - jest/vitest: `FAIL path` + `● Suite › case › message`
 *
 * Lines that don't match any pattern become a generic span with the
 * tool set to the running adapter and no location/code, so the caller
 * still gets a fingerprint reflecting the failure text.
 */
export function parseFailures(log: string, tool: GateName | string = 'unit'): FailureSpan[] {
  const spans: FailureSpan[] = [];
  const lines = log.split(/\r?\n/u);
  for (const line of lines) {
    const ts = matchTypeScript(line);
    if (ts) {
      spans.push({ tool, ...ts });
      continue;
    }
    const eslint = matchEslint(line);
    if (eslint) {
      spans.push({ tool, ...eslint });
      continue;
    }
    const jest = matchJest(line);
    if (jest) {
      spans.push({ tool, ...jest });
      continue;
    }
    if (isFailureLine(line)) {
      spans.push({
        tool,
        filePath: null,
        line: null,
        rule: null,
        messageTemplate: normalizeMessage(line),
      });
    }
  }
  return spans;
}

function matchTypeScript(
  line: string,
): { filePath: string; line: number; rule: string; messageTemplate: string } | null {
  // src/a.ts(12,3): error TS2322: Type 'string' is not assignable to type 'number'.
  const m = /^(.+?)\((\d+),(?:\d+)\):\s+(?:error|warning)\s+(TS\d+):\s+(.*)$/u.exec(line);
  if (!m) return null;
  const path = m[1];
  const lineStr = m[2];
  const rule = m[3];
  const msg = m[4];
  if (path === undefined || lineStr === undefined || rule === undefined || msg === undefined) {
    return null;
  }
  return {
    filePath: path,
    line: Number(lineStr),
    rule,
    messageTemplate: normalizeMessage(msg),
  };
}

function matchEslint(
  line: string,
): { filePath: string; line: number; rule: string; messageTemplate: string } | null {
  // src/a.ts:12:3: error  no-unused-vars  'x' is defined but never used
  const m = /^(.+?):(\d+):\d+:\s+(?:error|warning)\s+(\S+)\s+(.*)$/u.exec(line);
  if (!m) return null;
  const path = m[1];
  const lineStr = m[2];
  const rule = m[3];
  const msg = m[4];
  if (path === undefined || lineStr === undefined || rule === undefined || msg === undefined) {
    return null;
  }
  return {
    filePath: path,
    line: Number(lineStr),
    rule,
    messageTemplate: normalizeMessage(msg),
  };
}

function matchJest(
  line: string,
): { filePath: string | null; line: null; rule: null; messageTemplate: string } | null {
  // FAIL src/a.test.ts
  const fail = /^FAIL\s+(.+)$/u.exec(line);
  const path = fail?.[1];
  if (path !== undefined) {
    return { filePath: path.trim(), line: null, rule: null, messageTemplate: 'FAIL' };
  }
  return null;
}

function isFailureLine(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    line.length > 0 &&
    (/\berror\b/u.test(lower) || /\bfail(ed|ure)?\b/u.test(lower) || /\bexception\b/u.test(lower))
  );
}

/**
 * Normalize a message into a stable template:
 *   - replace digit runs with `<n>`
 *   - drop quoted-string contents (they often carry identifiers)
 *   - collapse whitespace
 *   - strip trailing punctuation
 *
 * The result is what the fingerprinter hashes; line/col numbers are
 * deliberately excluded so the same error on different lines collapses.
 */
export function normalizeMessage(message: string): string {
  let s = message;
  // Drop quoted content (single/double/backtick).
  s = s.replace(/'[^']*'/gu, "''");
  s = s.replace(/"[^"]*"/gu, '""');
  s = s.replace(/`[^`]*`/gu, '``');
  // Replace digit runs.
  s = s.replace(/\d+/gu, '<n>');
  // Collapse whitespace.
  s = s.replace(/\s+/gu, ' ').trim();
  // Strip trailing punctuation.
  s = s.replace(/[.;,]+$/u, '');
  return s;
}

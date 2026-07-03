/**
 * FingerprintService — T-M6-002, spec §12.7 / §20.
 *
 * Deterministic sha256 over a normalized (tool, filePath, rule,
 * messageTemplate) tuple. Same logical failure → same fingerprint
 * across runs, even when line numbers shift.
 *
 * Contract:
 *
 *   - `fingerprint(span)` is pure: same input → same digest, always.
 *   - Line numbers / column numbers are NOT part of the digest.
 *   - File paths are normalized to forward slashes and stripped of
 *     leading `./` so `./src/a.ts` and `src/a.ts` collide.
 */

import { createHash } from 'node:crypto';
import { stableJsonStringify } from '@cgao/schemas';
import type { FailureSpan } from './failure-parser.js';

export interface FingerprintInput {
  tool: string;
  filePath: string | null;
  rule: string | null;
  messageTemplate: string;
}

export type Fingerprint = string;

export class FingerprintService {
  /**
   * Returns `sha256:<hex>` — colon-prefixed so it's obviously a digest
   * and never confused with a free-form string in audit records.
   */
  fingerprint(span: FingerprintInput | FailureSpan): Fingerprint {
    const normalized: FingerprintInput = {
      tool: span.tool,
      filePath: normalizeFilePath(span.filePath),
      rule: span.rule ?? null,
      messageTemplate: span.messageTemplate,
    };
    const canonical = stableJsonStringify(normalized);
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }

  /**
   * Convenience: fingerprint a free-form message string. Used for
   * failure spans whose structured fields are unavailable.
   */
  fingerprintMessage(tool: string, message: string): Fingerprint {
    return this.fingerprint({
      tool,
      filePath: null,
      rule: null,
      messageTemplate: message,
    });
  }
}

export function normalizeFilePath(path: string | null): string | null {
  if (path === null) return null;
  let p = path.replace(/\\/gu, '/');
  if (p.startsWith('./')) p = p.slice(2);
  // Strip trailing position annotations some test runners append,
  // e.g. `src/a.test.ts:12:3`.
  p = p.replace(/:\d+(:\d+)?$/u, '');
  return p;
}

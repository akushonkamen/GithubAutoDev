/**
 * Gate log scrubber — T-M6-001, spec §13.1 / §13.3 / §20.
 *
 * Two layers:
 *
 *   1. `scrubRunnerEnv` (re-exported from profiles/env-scrubber) is
 *      the authoritative "no secret in the child env" gate. The runner
 *      MUST spawn adapters with the scrubbed env — never `process.env`.
 *   2. `scrubGateLog` runs the captured stdout/stderr through the
 *      @cgao/artifacts redactor so even if a malicious test manages
 *      to print a secret value (e.g. via `cat $GITHUB_TOKEN` after
 *      tricking a setup script), the persisted log contains
 *      `[REDACTED:...]` rather than the raw value.
 *
 * The redactor also returns a `findings` array so the gate can record
 * what was scrubbed in audit without re-leaking the secret value.
 */

import { type RedactionFinding, redact } from '@cgao/artifacts';

export interface ScrubbedLog {
  redacted: string;
  findings: readonly RedactionFinding[];
  /** 'security_sensitive' if any finding, else 'clean'. */
  classification: 'clean' | 'security_sensitive';
}

export function scrubGateLog(text: string): ScrubbedLog {
  const result = redact(text);
  return {
    redacted: result.redacted,
    findings: result.findings,
    classification: result.classification,
  };
}

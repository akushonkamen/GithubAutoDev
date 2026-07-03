/**
 * No-secret execution profile + token presence test — T-M5-004,
 * spec §13.1 / §13.3 / §20.
 *
 * The NoSecretExecutionProfile is the fail-closed gate the broker
 * runs BEFORE dispatching an untrusted job. It confirms the resolved
 * env carries NONE of the forbidden keys. If any are present, the
 * dispatch is aborted.
 *
 * The TokenPresenceTest is the same check, expressed as a pure
 * predicate over an env object — used by the security regression
 * suite to assert "malicious script that prints process.env produces
 * no leaked secrets".
 */

import { FORBIDDEN_RUNNER_ENV_KEYS } from './env-scrubber.js';

export interface TokenPresenceViolation {
  /** Env var name that was present. */
  key: string;
  /** Why it was flagged. */
  reason: 'forbidden_list' | 'secret_suffix' | 'aws_prefix' | 'github_app_prefix';
}

export interface TokenPresenceResult {
  /** True when the env is clean (no violations). */
  ok: boolean;
  /** Per-key violations, in deterministic order. */
  violations: readonly TokenPresenceViolation[];
}

/**
 * NoSecretExecutionProfile: scan an env object and report violations.
 * Pure — does not mutate the input.
 */
export const NoSecretExecutionProfile = {
  scan(env: NodeJS.ProcessEnv): TokenPresenceResult {
    const violations: TokenPresenceViolation[] = [];
    const forbidden = new Set<string>(FORBIDDEN_RUNNER_ENV_KEYS);
    const keys = Object.keys(env).sort();
    for (const key of keys) {
      const v = env[key];
      if (v === undefined) continue;
      if (forbidden.has(key)) {
        violations.push({ key, reason: 'forbidden_list' });
        continue;
      }
      if (key.startsWith('AWS_')) {
        violations.push({ key, reason: 'aws_prefix' });
        continue;
      }
      if (key.startsWith('GITHUB_APP_')) {
        violations.push({ key, reason: 'github_app_prefix' });
        continue;
      }
      if (key.endsWith('_SECRET') || key.endsWith('_TOKEN') || key.endsWith('_KEY')) {
        violations.push({ key, reason: 'secret_suffix' });
      }
    }
    return { ok: violations.length === 0, violations };
  },
};

/**
 * TokenPresenceTest: predicate form of NoSecretExecutionProfile.scan.
 * Returns true iff the env has zero violations.
 */
export function runTokenPresenceTest(env: NodeJS.ProcessEnv): boolean {
  return NoSecretExecutionProfile.scan(env).ok;
}

/**
 * Serialize an env object to a string. Used by the security regression
 * that simulates a malicious script printing `process.env` and asserts
 * the serialized form contains no leaked secret values.
 */
export function serializeEnv(env: NodeJS.ProcessEnv): string {
  return JSON.stringify(env);
}

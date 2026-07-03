/**
 * T-M5-004 no-secret execution profile regression.
 *
 * Locks the contracts (spec §13.1 / §13.3 / §20):
 *   - A malicious env containing every forbidden key produces zero
 *     violations AFTER scrubbing.
 *   - TokenPresenceTest passes when no forbidden keys are present.
 *   - NoSecretExecutionProfile.scan flags every forbidden key.
 */

import { describe, expect, it } from 'vitest';
import { CredentialProfile, CredentialProfileService } from '../profiles/credential-profile.js';
import { FORBIDDEN_RUNNER_ENV_KEYS, scrubRunnerEnv } from '../profiles/env-scrubber.js';
import {
  NoSecretExecutionProfile,
  runTokenPresenceTest,
  serializeEnv,
} from '../profiles/token-presence-test.js';

// Synthetic value that does NOT match the live-secret patterns in
// @cgao/test-utils (avoids tripping the repo secret-leak scan).
const SECRET = 'cgao-fake-secret-value-not-real';

describe('T-M5-004 NoSecretExecutionProfile + TokenPresenceTest', () => {
  it('scrubbed env passes TokenPresenceTest', () => {
    const dirty: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: SECRET,
      ANTHROPIC_API_KEY: SECRET,
      AWS_SECRET_ACCESS_KEY: SECRET,
      GITHUB_APP_ID: SECRET,
      PATH: '/usr/bin',
      HOME: '/root',
    };
    const clean = scrubRunnerEnv(dirty);
    expect(runTokenPresenceTest(clean)).toBe(true);
  });

  it('TokenPresenceTest fails when forbidden keys are present', () => {
    const env: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: SECRET,
      PATH: '/usr/bin',
    };
    expect(runTokenPresenceTest(env)).toBe(false);
  });

  it('NoSecretExecutionProfile.scan reports every forbidden key', () => {
    const env = Object.fromEntries(
      FORBIDDEN_RUNNER_ENV_KEYS.map((k) => [k, SECRET]),
    ) as NodeJS.ProcessEnv;
    const result = NoSecretExecutionProfile.scan(env);
    expect(result.ok).toBe(false);
    const flagged = new Set(result.violations.map((v) => v.key));
    for (const key of FORBIDDEN_RUNNER_ENV_KEYS) {
      expect(flagged.has(key), `${key} must be flagged`).toBe(true);
    }
  });

  it('serialized scrubbed env contains no leaked secret value', () => {
    const dirty: NodeJS.ProcessEnv = { GITHUB_TOKEN: SECRET, PATH: '/usr/bin' };
    const clean = scrubRunnerEnv(dirty);
    expect(serializeEnv(clean)).not.toContain(SECRET);
  });

  it('CredentialProfileService strips all forbidden keys for untrusted profile', () => {
    const parent: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: SECRET,
      ANTHROPIC_API_KEY: SECRET,
      AWS_ACCESS_KEY_ID: SECRET,
      PATH: '/usr/bin',
    };
    const svc = new CredentialProfileService(parent);
    const resolved = svc.resolve('executor');
    expect(resolved.profile).toBe(CredentialProfile.UNTRUSTED_CODE);
    expect(runTokenPresenceTest(resolved.env)).toBe(true);
    expect(resolved.env.GITHUB_TOKEN).toBeUndefined();
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.env.AWS_ACCESS_KEY_ID).toBeUndefined();
    // Sanitized env retains PATH.
    expect(resolved.env.PATH).toBe('/usr/bin');
  });
});

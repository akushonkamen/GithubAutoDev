/**
 * Runner no-secret regression — attack-scenarios/runner-exfiltration.md,
 * spec §13.1, AS-06 / AS-IM-05, T-M5-004.
 *
 * Validates the `scrubRunnerEnv` helper used by runner-broker to
 * construct the child_process env for untrusted code. Anything in
 * FORBIDDEN_RUNNER_ENV_KEYS — or matching the suffix pattern — must
 * never survive into the child env.
 */

import { describe, expect, it } from 'vitest';
import { FORBIDDEN_RUNNER_ENV_KEYS, scrubRunnerEnv } from '../index.js';

const SECRET_VALUE = 'ghs_lease_000000000000000000000000000000000000';

describe('runner no-secret env scrubbing', () => {
  it('removes every explicitly forbidden env var', () => {
    const input = Object.fromEntries(
      FORBIDDEN_RUNNER_ENV_KEYS.map((k) => [k, SECRET_VALUE]),
    ) as NodeJS.ProcessEnv;
    const out = scrubRunnerEnv(input);
    for (const key of FORBIDDEN_RUNNER_ENV_KEYS) {
      expect(out[key], `${key} must be scrubbed`).toBeUndefined();
    }
  });

  it('removes any var matching _SECRET / _TOKEN / _KEY suffix', () => {
    const input: NodeJS.ProcessEnv = {
      RANDOM_API_TOKEN: 'leak',
      FOO_SECRET: 'leak',
      BAR_KEY: 'leak',
      PATH: '/usr/bin',
      NODE_OPTIONS: '--max-old-space-size=512',
    };
    const out = scrubRunnerEnv(input);
    expect(out.RANDOM_API_TOKEN).toBeUndefined();
    expect(out.FOO_SECRET).toBeUndefined();
    expect(out.BAR_KEY).toBeUndefined();
    expect(out.PATH).toBe('/usr/bin');
    expect(out.NODE_OPTIONS).toBe('--max-old-space-size=512');
  });

  it('does not leak secret values into the scrubbed env', () => {
    const out = scrubRunnerEnv({ GITHUB_TOKEN: SECRET_VALUE } as NodeJS.ProcessEnv);
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SECRET_VALUE);
  });
});

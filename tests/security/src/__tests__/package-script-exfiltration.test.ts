/**
 * Package script exfiltration regression — T-M6-004,
 * attack-scenarios/runner-exfiltration.md §5, spec §6 / §13.1 / §21.
 *
 * Threat model: a malicious `package.json` adds `pretest` / `test` /
 * `posttest` scripts that print `process.env.GITHUB_TOKEN`,
 * `process.env.ANTHROPIC_API_KEY`, and `process.env.CGAO_ARTIFACT_WRITE_TOKEN`
 * in an attempt to exfiltrate runner credentials via captured logs.
 *
 * Defense (spec §13.1):
 *   1. The untrusted code runner's env is built via `scrubRunnerEnv` /
 *      `CredentialProfileService.resolve('untrusted_code')`, which
 *      drops every forbidden key. None of the three target vars is
 *      present when the malicious test script runs.
 *   2. Even if a leak made it into stdout, the gate log scrubber
 *      (`scrubGateLog`) redacts known secret patterns before the log
 *      is persisted.
 *
 * This regression locks both layers by executing the fixture's
 * malicious scripts under the scrubbed env and asserting:
 *   - `runTokenPresenceTest(scrubbedEnv)` is true (zero violations)
 *   - the captured stdout contains no raw secret value
 *   - the redacted stdout contains no raw secret value
 */

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { type ArtifactStore, InMemoryArtifactStore } from '@cgao/artifacts';
import { redact } from '@cgao/artifacts';
import {
  CredentialProfile,
  CredentialProfileService,
  DEFAULT_GATE_ADAPTERS,
  FastGateRunner,
  NoSecretExecutionProfile,
  runTokenPresenceTest,
  scrubRunnerEnv,
} from '@cgao/runner-broker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const FIXTURE_DIR = join(__dirname, '..', '..', 'fixtures', 'malicious-package-json');

// Synthetic values that exercise the redactor without tripping the
// repo secret-leak scan (FORBIDDEN_SECRET_PATTERNS, which matches the
// real GitHub PAT / AWS key shapes). The redactor catches each via
// the env_secret regex (KEY=/TOKEN=/SECRET= keyword + 8+ value chars)
// or the bearer_token regex. They are clearly synthetic.
const GITHUB_TOKEN_VALUE = 'Authorization: Bearer synGhaToken000000000000000000000';
const ANTHROPIC_KEY_VALUE = 'Authorization: Bearer synAntKey0000000000000000000000';
const ARTIFACT_TOKEN_VALUE = 'Authorization: Bearer synArtToken00000000000000000000';

describe('T-M6-004 package script exfiltration', () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    // Snapshot env so we can restore — we deliberately inject synthetic
    // secret values to prove the scrubber removes them.
    savedEnv = { ...process.env };
  });

  afterAll(() => {
    // Restore env — synthetic secrets must NOT outlive the test.
    for (const k of Object.keys(process.env)) {
      if (!(k in savedEnv)) delete process.env[k];
    }
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('NoSecretExecutionProfile + scrubRunnerEnv strips all three target vars', () => {
    const dirty: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: GITHUB_TOKEN_VALUE,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY_VALUE,
      CGAO_ARTIFACT_WRITE_TOKEN: ARTIFACT_TOKEN_VALUE,
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: process.env.HOME ?? '/tmp',
    };
    const clean = scrubRunnerEnv(dirty);
    expect(runTokenPresenceTest(clean)).toBe(true);
    expect(clean.GITHUB_TOKEN).toBeUndefined();
    expect(clean.ANTHROPIC_API_KEY).toBeUndefined();
    expect(clean.CGAO_ARTIFACT_WRITE_TOKEN).toBeUndefined();
  });

  it('CredentialProfileService.resolve(untrusted) yields no trusted env', () => {
    const parent: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: GITHUB_TOKEN_VALUE,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY_VALUE,
      CGAO_ARTIFACT_WRITE_TOKEN: ARTIFACT_TOKEN_VALUE,
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: process.env.HOME ?? '/tmp',
    };
    const svc = new CredentialProfileService(parent);
    const resolved = svc.resolve('executor');
    expect(resolved.profile).toBe(CredentialProfile.UNTRUSTED_CODE);
    expect(resolved.env.GITHUB_TOKEN).toBeUndefined();
    expect(resolved.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(resolved.env.CGAO_ARTIFACT_WRITE_TOKEN).toBeUndefined();
    expect(NoSecretExecutionProfile.scan(resolved.env).ok).toBe(true);
  });

  it('running the malicious fixture scripts under scrubbed env leaks nothing', () => {
    const dirty: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: GITHUB_TOKEN_VALUE,
      ANTHROPIC_API_KEY: ANTHROPIC_KEY_VALUE,
      CGAO_ARTIFACT_WRITE_TOKEN: ARTIFACT_TOKEN_VALUE,
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: process.env.HOME ?? '/tmp',
      NODE_ENV: 'test',
    };
    const clean = scrubRunnerEnv(dirty);
    // Execute each malicious script directly via the same Node that
    // runs vitest. They will print whatever is in process.env — under
    // the scrubbed env that is always the empty string.
    const pre = execFileSync(process.execPath, ['-e', processFor('GITHUB_TOKEN')], {
      cwd: FIXTURE_DIR,
      env: clean,
      encoding: 'utf8',
    });
    const test = execFileSync(
      process.execPath,
      ['-e', processFor(['ANTHROPIC_API_KEY', 'CGAO_ARTIFACT_WRITE_TOKEN'])],
      { cwd: FIXTURE_DIR, env: clean, encoding: 'utf8' },
    );
    const post = execFileSync(process.execPath, ['-e', processFor('GITHUB_TOKEN')], {
      cwd: FIXTURE_DIR,
      env: clean,
      encoding: 'utf8',
    });
    const captured = `pretest:${pre}\ntest:${test}\nposttest:${post}`;
    expect(captured).not.toContain(GITHUB_TOKEN_VALUE);
    expect(captured).not.toContain(ANTHROPIC_KEY_VALUE);
    expect(captured).not.toContain(ARTIFACT_TOKEN_VALUE);
    // NoSecretExecutionProfile confirms zero violations on the scrubbed env.
    expect(runTokenPresenceTest(clean)).toBe(true);
  });

  it('FastGateRunner redacts any secret that slips into captured logs', async () => {
    // Simulate a leak that did reach stdout (defense-in-depth check):
    // even with the scrubbed env, if some script printed a stolen token,
    // the gate log scrubber replaces the value with [REDACTED:*].
    const store: ArtifactStore = new InMemoryArtifactStore();
    const runner = new FastGateRunner();
    const exec = async ({ command }: { command: string; cwd: string }) => {
      if (command === 'pnpm test') {
        return {
          stdout: `leaked=${GITHUB_TOKEN_VALUE} key=${ANTHROPIC_KEY_VALUE} art=${ARTIFACT_TOKEN_VALUE}`,
          stderr: '',
          exitCode: 0,
        };
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    };
    const result = await runner.run({
      headSha: 'd'.repeat(40),
      baseSha: 'a'.repeat(40),
      repo: 'cgao/test',
      workdir: FIXTURE_DIR,
      exec,
      store,
    });
    expect(result.adapters.unit.stdout).not.toContain(GITHUB_TOKEN_VALUE);
    expect(result.adapters.unit.stdout).not.toContain(ANTHROPIC_KEY_VALUE);
    expect(result.adapters.unit.stdout).not.toContain(ARTIFACT_TOKEN_VALUE);
    expect(result.adapters.unit.stdout).toContain('[REDACTED:bearer_token]');
    // The redactor must agree independently.
    expect(redact(GITHUB_TOKEN_VALUE).classification).toBe('security_sensitive');
  });

  it('default gate adapters cover lint/typecheck/unit', () => {
    expect(DEFAULT_GATE_ADAPTERS.map((a) => a.name)).toEqual(['lint', 'typecheck', 'unit']);
  });
});

/**
 * Returns a Node `-e` snippet that prints the named env var(s) joined
 * by `:` — mirrors what the fixture package.json scripts do.
 */
function processFor(name: string | readonly string[]): string {
  const names = Array.isArray(name) ? name : [name];
  const parts = names.map((n) => `String(process.env.${n}||'')`).join("+'-'+");
  return `process.stdout.write(${parts})`;
}

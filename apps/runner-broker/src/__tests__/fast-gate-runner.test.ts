/**
 * T-M6-001 FastGateRunner regression.
 *
 * Contracts (spec §12.7):
 *   - GateResult is SHA-bound to (head_sha, base_sha, adapterResults)
 *   - log artifact is scrubbed of secrets before being persisted
 *   - pass/fail reflects every adapter's exit code
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATE_ADAPTERS,
  FastGateRunner,
  type GateCommandExecutor,
} from '../gate/fast-gate-runner.js';

const HEAD_SHA = 'def4560000000000000000000000000000000000';
const BASE_SHA = 'abc1230000000000000000000000000000000000';

function makeExec(
  responses: Record<string, { stdout: string; stderr: string; exitCode: number }>,
): GateCommandExecutor {
  return async ({ command }) => {
    const hit = responses[command];
    if (!hit) throw new Error(`unexpected command: ${command}`);
    return hit;
  };
}

describe('T-M6-001 FastGateRunner', () => {
  it('returns passed=true when every adapter exits 0', async () => {
    const store = new InMemoryArtifactStore();
    const runner = new FastGateRunner();
    const exec = makeExec({
      'pnpm lint': { stdout: 'lint ok', stderr: '', exitCode: 0 },
      'pnpm -r typecheck': { stdout: 'tsc ok', stderr: '', exitCode: 0 },
      'pnpm test': { stdout: 'tests ok', stderr: '', exitCode: 0 },
    });
    const result = await runner.run({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      repo: 'cgao/test',
      workdir: '/repo',
      exec,
      store,
    });
    expect(result.passed).toBe(true);
    expect(result.adapters.lint.passed).toBe(true);
    expect(result.adapters.typecheck.passed).toBe(true);
    expect(result.adapters.unit.passed).toBe(true);
    expect(result.bindingHash).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.logArtifactRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it('returns passed=false when any adapter exits non-zero', async () => {
    const store = new InMemoryArtifactStore();
    const runner = new FastGateRunner();
    const exec = makeExec({
      'pnpm lint': { stdout: 'lint ok', stderr: '', exitCode: 0 },
      'pnpm -r typecheck': {
        stdout: 'src/a.ts:1:1 - error TS2322: bad type',
        stderr: '',
        exitCode: 1,
      },
      'pnpm test': { stdout: 'tests ok', stderr: '', exitCode: 0 },
    });
    const result = await runner.run({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      repo: 'cgao/test',
      workdir: '/repo',
      exec,
      store,
    });
    expect(result.passed).toBe(false);
    expect(result.adapters.typecheck.passed).toBe(false);
    expect(result.adapters.typecheck.exitCode).toBe(1);
  });

  it('scrubs known secret patterns from persisted logs', async () => {
    const store = new InMemoryArtifactStore();
    const runner = new FastGateRunner();
    // Use a Bearer-token shape that the @cgao/artifacts redactor catches
    // (bearer_token pattern) but does NOT match the repo secret-leak scan
    // (which only matches the live GitHub PAT / AWS key shapes).
    const LEAKED = 'Authorization: Bearer aS9k7Wj2pL3mRt8nVbYc6Hs4Zt1xQwEr';
    const exec = makeExec({
      'pnpm lint': { stdout: 'lint ok', stderr: '', exitCode: 0 },
      'pnpm -r typecheck': { stdout: 'tsc ok', stderr: '', exitCode: 0 },
      'pnpm test': {
        // malicious test prints a stolen token; the scrubber must redact it
        // before the log artifact is persisted.
        stdout: `running tests... token=${LEAKED} done`,
        stderr: '',
        exitCode: 0,
      },
    });
    const result = await runner.run({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      repo: 'cgao/test',
      workdir: '/repo',
      exec,
      store,
    });
    expect(result.adapters.unit.stdout).not.toContain(LEAKED);
    expect(result.adapters.unit.stdout).toContain('[REDACTED:bearer_token]');
    // Persisted artifact must also not contain the raw secret.
    const artifact = await store.read(result.logArtifactRef);
    expect(artifact, 'gate log artifact must be persisted').not.toBeNull();
    expect(artifact?.content).not.toContain(LEAKED);
  });

  it('binding hash changes when head_sha changes', async () => {
    const store = new InMemoryArtifactStore();
    const runner = new FastGateRunner();
    const exec = makeExec({
      'pnpm lint': { stdout: '', stderr: '', exitCode: 0 },
      'pnpm -r typecheck': { stdout: '', stderr: '', exitCode: 0 },
      'pnpm test': { stdout: '', stderr: '', exitCode: 0 },
    });
    const a = await runner.run({
      headSha: HEAD_SHA,
      baseSha: BASE_SHA,
      repo: 'cgao/test',
      workdir: '/repo',
      exec,
      store,
    });
    const b = await runner.run({
      headSha: 'fff9990000000000000000000000000000000000',
      baseSha: BASE_SHA,
      repo: 'cgao/test',
      workdir: '/repo',
      exec,
      store,
    });
    expect(a.bindingHash).not.toEqual(b.bindingHash);
  });

  it('uses lint/typecheck/unit adapters by default', () => {
    expect(DEFAULT_GATE_ADAPTERS.map((a) => a.name)).toEqual(['lint', 'typecheck', 'unit']);
  });
});

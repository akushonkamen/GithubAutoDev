/**
 * T-M6-003 TestFixLoopController regression.
 *
 * Contracts (spec §12.7 / §23):
 *   - MAX_ROUNDS = 5 enforced
 *   - SAME_FINGERPRINT_LIMIT = 3 → state = BLOCKED
 *   - terminal states: FIXED | BLOCKED | GIVE_UP
 *   - per round: independent test-result + fix-result artifacts
 *   - failure log fed to fix agent is wrapped via wrapUntrusted
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import { parseFailures } from '../gate/failure-parser.js';
import { FingerprintService } from '../gate/fingerprint.js';
import {
  MAX_ROUNDS,
  SAME_FINGERPRINT_LIMIT,
  TestFixLoopController,
} from '../gate/test-fix-loop.js';
import type { GateResult } from '../gate/types.js';

const HEAD = 'def4560000000000000000000000000000000000';
const BASE = 'abc1230000000000000000000000000000000000';

function makeGate(passed: boolean, stdout: string, stderr = '', round = 0): GateResult {
  const adapterResult = {
    name: 'unit' as const,
    command: 'pnpm test',
    exitCode: passed ? 0 : 1,
    stdout,
    stderr,
    durationMs: 5,
    passed,
  };
  return {
    headSha: HEAD,
    baseSha: BASE,
    repo: 'cgao/test',
    passed,
    adapters: {
      lint: { ...adapterResult, name: 'lint', command: 'pnpm lint' },
      typecheck: { ...adapterResult, name: 'typecheck', command: 'pnpm -r typecheck' },
      unit: adapterResult,
    },
    bindingHash: `sha256:${passed ? '1' : '0'}${'0'.repeat(63)}`,
    logArtifactRef: `sha256:log${passed ? '1' : '0'}${String(round).padStart(2, '0')}${'0'.repeat(56)}`,
  };
}

const wrapUntrusted = (text: string): string =>
  `<<<UNTRUSTED_CONTENT BEGIN>>>\n${text}\n<<<UNTRUSTED_CONTENT END>>>`;

describe('T-M6-003 TestFixLoopController', () => {
  it('terminal state FIXED when gate passes on round 1', async () => {
    const store = new InMemoryArtifactStore();
    const loop = new TestFixLoopController();
    const result = await loop.run({
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      workdir: '/repo',
      store,
      fingerprintService: new FingerprintService(),
      parseFailures,
      wrapUntrusted,
      gateRunner: { run: async () => makeGate(true, 'all green') },
      runDebugger: async () => 'noop',
      runFix: async () => 'noop',
    });
    expect(result.finalState).toBe('FIXED');
    expect(result.rounds.length).toBe(1);
    expect(result.rounds[0]?.round).toBe(1);
  });

  it('terminal state GIVE_UP after MAX_ROUNDS without pass', async () => {
    const store = new InMemoryArtifactStore();
    const loop = new TestFixLoopController();
    // Each round produces a *different* failure text (distinct literal
    // rule codes so the fingerprint differs every round) — we want
    // GIVE_UP, not BLOCKED.
    let n = 0;
    const result = await loop.run({
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      workdir: '/repo',
      store,
      fingerprintService: new FingerprintService(),
      parseFailures,
      wrapUntrusted,
      gateRunner: {
        run: async () => {
          const round = n + 1;
          return makeGate(
            false,
            `src/a.ts(1,1): error TS${1000 + n++}: distinct error message`,
            '',
            round,
          );
        },
      },
      runDebugger: async () => 'dbg',
      runFix: async () => 'fix',
    });
    expect(result.finalState).toBe('GIVE_UP');
    expect(result.rounds.length).toBe(MAX_ROUNDS);
  });

  it('terminal state BLOCKED when same fingerprint seen SAME_FINGERPRINT_LIMIT times', async () => {
    const store = new InMemoryArtifactStore();
    const loop = new TestFixLoopController();
    // Identical failure every round → identical fingerprint.
    const failureText = "src/a.ts(1,1): error TS2322: Type 'string' is not assignable.";
    const result = await loop.run({
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      workdir: '/repo',
      store,
      fingerprintService: new FingerprintService(),
      parseFailures,
      wrapUntrusted,
      gateRunner: { run: async () => makeGate(false, failureText) },
      runDebugger: async () => 'dbg',
      runFix: async () => 'fix',
    });
    expect(result.finalState).toBe('BLOCKED');
    expect(result.rounds.length).toBe(SAME_FINGERPRINT_LIMIT);
  });

  it('each round emits independent test-result + fix-result refs', async () => {
    const store = new InMemoryArtifactStore();
    const loop = new TestFixLoopController();
    let n = 0;
    const result = await loop.run({
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      workdir: '/repo',
      store,
      fingerprintService: new FingerprintService(),
      parseFailures,
      wrapUntrusted,
      gateRunner: {
        run: async () => {
          const round = n + 1;
          return makeGate(
            false,
            `src/a.ts(1,1): error TS${2000 + n++}: distinct error message`,
            '',
            round,
          );
        },
      },
      runDebugger: async () => 'dbg',
      runFix: async () => 'fix',
    });
    const fixRefs = result.rounds.map((r) => r.fixResultRef);
    const testRefs = result.rounds.map((r) => r.testResultRef);
    expect(new Set(fixRefs).size).toBe(fixRefs.length);
    expect(new Set(testRefs).size).toBe(testRefs.length);
  });

  it('failure log is wrapped via wrapUntrusted before reaching the agents', async () => {
    const store = new InMemoryArtifactStore();
    const loop = new TestFixLoopController();
    let debuggerGotWrapped = '';
    let fixGotWrapped = '';
    // Use distinct rule codes per round so the loop dispatches agents
    // rather than blocking early.
    let n = 0;
    const result = await loop.run({
      headSha: HEAD,
      baseSha: BASE,
      repo: 'cgao/test',
      workdir: '/repo',
      store,
      fingerprintService: new FingerprintService(),
      parseFailures,
      wrapUntrusted,
      gateRunner: {
        run: async () =>
          makeGate(false, `src/a.ts(1,1): error TS${3000 + n++}: distinct error message`),
      },
      runDebugger: async (args) => {
        debuggerGotWrapped = args.wrappedFailureLog;
        return 'dbg';
      },
      runFix: async (args) => {
        fixGotWrapped = args.wrappedFailureLog;
        return 'fix';
      },
    });
    expect(result.finalState).not.toBe('FIXED');
    expect(debuggerGotWrapped).toContain('<<<UNTRUSTED_CONTENT BEGIN>>>');
    expect(fixGotWrapped).toContain('<<<UNTRUSTED_CONTENT BEGIN>>>');
  });
});

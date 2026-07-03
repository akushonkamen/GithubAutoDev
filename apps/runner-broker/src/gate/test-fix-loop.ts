/**
 * TestFixLoopController — T-M6-003, spec §12.7 / §23.
 *
 * UltraQA-style loop:
 *
 *   for round in 1..=MAX_ROUNDS:
 *     1. run gate (lint+typecheck+unit) on the workdir
 *     2. if gate passed → state = FIXED, return
 *     3. parse failures, fingerprint each
 *     4. if any fingerprint has been seen SAME_FINGERPRINT_LIMIT times
 *        → state = BLOCKED, return
 *     5. dispatch a DebuggerAgentRun on the rolled-up failures
 *     6. dispatch a FixAgentRun with the debugger output + the
 *        wrapped-untrusted failure log
 *     7. apply the fix patch (caller's responsibility); loop continues
 *
 * If MAX_ROUNDS is reached without passing, state = GIVE_UP.
 *
 * Each round emits TWO independent artifacts:
 *   - `test-result` (gate log) — via FastGateRunner
 *   - `fix-result` (debugger + fix agent output) — produced here
 *
 * Security: build error text fed back to the fix agent is wrapped
 * with `wrapUntrusted` so a malicious build error cannot inject
 * instructions into the agent prompt.
 */

import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactStore, computeArtifactKey } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import type { FailureSpan } from './failure-parser.js';
import type { FingerprintService } from './fingerprint.js';
import type { GateResult } from './types.js';

export const MAX_ROUNDS = 5;
export const SAME_FINGERPRINT_LIMIT = 3;

export type TestFixLoopState = 'FIXED' | 'BLOCKED' | 'GIVE_UP' | 'IN_PROGRESS';

/**
 * Per-round fix artifact body. Persisted as an `Artifact` of kind
 * `raw_payload` (the only kind the M2 store supports today); content
 * is canonical JSON so its sha256 is stable.
 */
export interface FixResultArtifactBody {
  kind: 'fix_result';
  round: number;
  headSha: string;
  baseSha: string;
  repo: string;
  /** Untrusted-envelope-wrapped failure log fed to the fix agent. */
  wrappedFailureLog: string;
  /** Debugger agent raw output (also envelope-wrapped before use). */
  debuggerOutput: string;
  /** Fix agent raw output (the proposed patch text, if any). */
  fixOutput: string;
  /** Fingerprints the round produced. */
  fingerprints: readonly string[];
}

export interface FixResultArtifact extends Artifact {
  content: string;
}

export interface RoundRecord {
  round: number;
  gate: GateResult;
  testResultRef: string;
  fixResultRef: string;
  fingerprints: readonly string[];
}

export interface TestFixLoopResult {
  finalState: TestFixLoopState;
  rounds: readonly RoundRecord[];
  /** Last gate result (for the orchestrator to consume). */
  lastGate: GateResult | null;
}

/** Injected gate runner — production wires FastGateRunner. */
export interface GateRunnerPort {
  run(args: {
    headSha: string;
    baseSha: string;
    repo: string;
    workdir: string;
  }): Promise<GateResult>;
}

/** Wraps untrusted content with hard delimiters (orchestrator import). */
export type WrapUntrustedFn = (text: string) => string;

export interface TestFixLoopDeps {
  gateRunner: GateRunnerPort;
  fingerprintService: FingerprintService;
  parseFailures: (log: string, tool?: string) => readonly FailureSpan[];
  wrapUntrusted: WrapUntrustedFn;
  store: ArtifactStore;
  /** Run the debugger agent over the rolled-up failure log. */
  runDebugger: (args: {
    round: number;
    wrappedFailureLog: string;
    gate: GateResult;
  }) => Promise<string>;
  /** Run the fix agent; returns the proposed patch text. */
  runFix: (args: {
    round: number;
    wrappedFailureLog: string;
    debuggerOutput: string;
    gate: GateResult;
  }) => Promise<string>;
}

export interface TestFixLoopInput extends TestFixLoopDeps {
  headSha: string;
  baseSha: string;
  repo: string;
  workdir: string;
  runId?: string;
  maxRounds?: number;
  sameFingerprintLimit?: number;
}

export class TestFixLoopController {
  async run(input: TestFixLoopInput): Promise<TestFixLoopResult> {
    const maxRounds = input.maxRounds ?? MAX_ROUNDS;
    const fpLimit = input.sameFingerprintLimit ?? SAME_FINGERPRINT_LIMIT;
    const seen = new Map<string, number>();
    const rounds: RoundRecord[] = [];

    for (let round = 1; round <= maxRounds; round++) {
      const gate = await input.gateRunner.run({
        headSha: input.headSha,
        baseSha: input.baseSha,
        repo: input.repo,
        workdir: input.workdir,
      });

      // FIXED on first clean gate.
      if (gate.passed) {
        rounds.push(this.syntheticPassRound(round, gate));
        return { finalState: 'FIXED', rounds, lastGate: gate };
      }

      // Parse failures from the rolled-up gate log and fingerprint each.
      // Fingerprints are deduped per round so a single broken build that
      // surfaces in lint+typecheck+unit logs does not triple-count.
      const failureLog = this.renderFailureLog(gate);
      const fingerprints = this.computeFingerprints(failureLog, gate, input);

      // BLOCKED if any fingerprint has been seen fpLimit times.
      for (const fp of fingerprints) {
        seen.set(fp, (seen.get(fp) ?? 0) + 1);
      }
      const blocked = fingerprints.find((fp) => (seen.get(fp) ?? 0) >= fpLimit);
      if (blocked !== undefined) {
        const fixRef = await this.persistFixArtifact({
          round,
          input,
          wrappedFailureLog: input.wrapUntrusted(failureLog),
          debuggerOutput: '',
          fixOutput: '',
          fingerprints,
        });
        rounds.push({
          round,
          gate,
          testResultRef: gate.logArtifactRef,
          fixResultRef: fixRef,
          fingerprints,
        });
        return { finalState: 'BLOCKED', rounds, lastGate: gate };
      }

      // Dispatch debugger + fix agents. Failure log is wrapped before
      // being fed back so a malicious build error cannot inject
      // instructions into the agent prompt.
      const wrapped = input.wrapUntrusted(failureLog);
      const debuggerOutput = await input.runDebugger({
        round,
        wrappedFailureLog: wrapped,
        gate,
      });
      const fixOutput = await input.runFix({
        round,
        wrappedFailureLog: wrapped,
        debuggerOutput,
        gate,
      });

      const fixRef = await this.persistFixArtifact({
        round,
        input,
        wrappedFailureLog: wrapped,
        debuggerOutput,
        fixOutput,
        fingerprints,
      });

      rounds.push({
        round,
        gate,
        testResultRef: gate.logArtifactRef,
        fixResultRef: fixRef,
        fingerprints,
      });
    }

    return {
      finalState: 'GIVE_UP',
      rounds,
      lastGate: rounds.length > 0 ? (rounds[rounds.length - 1]?.gate ?? null) : null,
    };
  }

  private renderFailureLog(gate: GateResult): string {
    const parts: string[] = [];
    for (const name of Object.keys(gate.adapters) as readonly (keyof typeof gate.adapters)[]) {
      const r = gate.adapters[name];
      parts.push(`### ${r.name} (exit ${r.exitCode})\nstdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    }
    return parts.join('\n\n');
  }

  private computeFingerprints(
    failureLog: string,
    gate: GateResult,
    input: TestFixLoopInput,
  ): string[] {
    // Use the failed adapter(s) as the tool hint.
    const tools = (Object.values(gate.adapters) as readonly { name: string; passed: boolean }[])
      .filter((a) => !a.passed)
      .map((a) => a.name);
    const fps: string[] = [];
    const dedup = new Set<string>();
    for (const tool of tools) {
      const spans = input.parseFailures(failureLog, tool);
      for (const span of spans) {
        const fp = input.fingerprintService.fingerprint(span);
        if (dedup.has(fp)) continue;
        dedup.add(fp);
        fps.push(fp);
      }
    }
    return fps;
  }

  private async persistFixArtifact(args: {
    round: number;
    input: TestFixLoopInput;
    wrappedFailureLog: string;
    debuggerOutput: string;
    fixOutput: string;
    fingerprints: readonly string[];
  }): Promise<string> {
    const body: FixResultArtifactBody = {
      kind: 'fix_result',
      round: args.round,
      headSha: args.input.headSha,
      baseSha: args.input.baseSha,
      repo: args.input.repo,
      wrappedFailureLog: args.wrappedFailureLog,
      debuggerOutput: args.debuggerOutput,
      fixOutput: args.fixOutput,
      fingerprints: [...args.fingerprints],
    };
    const content = stableJsonStringify(body);
    const key = computeArtifactKey(content);
    const artifact: Artifact = {
      kind: 'raw_payload',
      key,
      content,
      repo: args.input.repo,
      runId: args.input.runId ?? null,
      createdAt: new Date().toISOString(),
    };
    await args.input.store.write(artifact);
    return key;
  }

  private syntheticPassRound(round: number, gate: GateResult): RoundRecord {
    // A passing round emits no fix artifact; we synthesize a placeholder
    // ref derived from the gate log so consumers always have a stable
    // reference. The placeholder is NOT persisted as a separate artifact
    // (callers should check `gate.passed` to distinguish).
    const placeholderHash = `sha256:${createHash('sha256')
      .update(`pass:${round}:${gate.bindingHash}`)
      .digest('hex')}`;
    return {
      round,
      gate,
      testResultRef: gate.logArtifactRef,
      fixResultRef: placeholderHash,
      fingerprints: [],
    };
  }
}

/**
 * FastGateRunner — T-M6-001, spec §12.7.
 *
 * Runs the configured gate adapters (lint, typecheck, unit) against a
 * sandboxed workdir, captures stdout/stderr/exit per adapter, scrubs
 * secrets, persists a rolled-up log artifact, and returns a SHA-bound
 * `GateResult`.
 *
 * The runner is environment-independent: callers inject the
 * `GateCommandExecutor` (real child_process in prod, stub in tests)
 * and the `ArtifactStore` (FS in prod, in-memory in tests).
 *
 * Security notes:
 *   - The adapter subprocess MUST be spawned with scrubRunnerEnv(env),
 *     never with `process.env` directly. `FastGateRunner` does not
 *     perform the spawn itself (it goes through the executor), so the
 *     caller is responsible — see T-M6-004 for the regression that
 *     locks this contract.
 */

import { createHash } from 'node:crypto';
import { type Artifact, type ArtifactStore, computeArtifactKey } from '@cgao/artifacts';
import { stableJsonStringify } from '@cgao/schemas';
import { scrubGateLog } from './log-scrubber.js';
import type {
  AdapterRunResult,
  GateLogArtifactBody,
  GateName,
  GateResult,
  PerAdapterResults,
} from './types.js';

export interface FastGateRunInput {
  headSha: string;
  baseSha: string;
  repo: string;
  workdir: string;
  /** Adapters to run (default: lint + typecheck + unit). */
  adapters?: readonly GateAdapterSpec[];
  /** Command executor (real shell in prod, stub in tests). */
  exec: GateCommandExecutor;
  /** Where to persist the rolled-up log artifact. */
  store: ArtifactStore;
  /** Optional runId stamp on the persisted artifact. */
  runId?: string;
}

export interface GateAdapterSpec {
  name: GateName;
  command: string;
}

export type GateCommandExecutor = (args: {
  command: string;
  cwd: string;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

export const DEFAULT_GATE_ADAPTERS: readonly GateAdapterSpec[] = [
  { name: 'lint', command: 'pnpm lint' },
  { name: 'typecheck', command: 'pnpm -r typecheck' },
  { name: 'unit', command: 'pnpm test' },
];

export class FastGateRunner {
  async run(input: FastGateRunInput): Promise<GateResult> {
    const specs = input.adapters ?? DEFAULT_GATE_ADAPTERS;
    const results = await Promise.all(
      specs.map((spec) => this.runAdapter(spec, input.workdir, input.exec)),
    );

    const perAdapter = this.indexByGateName(specs, results);
    const passed = results.every((r) => r.passed);

    const bindingHash = this.computeBindingHash({
      headSha: input.headSha,
      baseSha: input.baseSha,
      adapters: perAdapter,
    });

    const body: GateLogArtifactBody = {
      kind: 'gate_log',
      headSha: input.headSha,
      baseSha: input.baseSha,
      repo: input.repo,
      adapters: perAdapter,
    };
    const content = stableJsonStringify(body);
    const key = computeArtifactKey(content);
    const artifact: Artifact = {
      kind: 'raw_payload',
      key,
      content,
      repo: input.repo,
      runId: input.runId ?? null,
      createdAt: new Date().toISOString(),
    };
    await input.store.write(artifact);

    return {
      headSha: input.headSha,
      baseSha: input.baseSha,
      repo: input.repo,
      passed,
      adapters: perAdapter,
      bindingHash,
      logArtifactRef: key,
    };
  }

  private async runAdapter(
    spec: GateAdapterSpec,
    workdir: string,
    exec: GateCommandExecutor,
  ): Promise<AdapterRunResult> {
    const start = Date.now();
    const raw = await exec({ command: spec.command, cwd: workdir });
    const durationMs = Date.now() - start;
    const stdout = scrubGateLog(raw.stdout);
    const stderr = scrubGateLog(raw.stderr);
    return {
      name: spec.name,
      command: spec.command,
      exitCode: raw.exitCode,
      stdout: stdout.redacted,
      stderr: stderr.redacted,
      durationMs,
      passed: raw.exitCode === 0,
    };
  }

  private indexByGateName(
    specs: readonly GateAdapterSpec[],
    results: readonly AdapterRunResult[],
  ): PerAdapterResults {
    const out = {} as PerAdapterResults;
    specs.forEach((spec, i) => {
      out[spec.name] = results[i] as AdapterRunResult;
    });
    return out;
  }

  private computeBindingHash(input: {
    headSha: string;
    baseSha: string;
    adapters: PerAdapterResults;
  }): string {
    const canonical = stableJsonStringify({
      headSha: input.headSha,
      baseSha: input.baseSha,
      adapters: input.adapters,
    });
    return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  }
}

// Re-export shared types so callers can `import { GateResult } from '.../fast-gate-runner.js'`.
export type {
  AdapterRunResult,
  GateResult,
  GateLogArtifactBody,
  GateName,
  PerAdapterResults,
} from './types.js';
export { scrubGateLog } from './log-scrubber.js';

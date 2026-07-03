/**
 * Fast gate types — T-M6-001, spec §12.7.
 *
 * The fast gate runs lint / typecheck / unit adapters against a
 * checked-out workdir, captures their stdout/stderr/exit code, scrubs
 * secrets from the captured logs, and writes a `test-result` artifact
 * per adapter plus a single rolled-up `GateResult`.
 *
 * `GateResult` is SHA-bound to (head_sha, base_sha): the binding hash
 * covers the canonical JSON of `{ headSha, baseSha, adapterResults }`
 * so a gate result is unforgeable — replays against a different commit
 * produce a different hash.
 *
 * Adapters are intentionally pluggable so unit tests can stub out the
 * shell.
 */

import type { Artifact } from '@cgao/artifacts';

/** SHA-1-ish commit identifier (40 hex chars) — we keep it loose for forks. */
export type Sha = string;

export type GateName = 'lint' | 'typecheck' | 'unit';

/** A single command + the captured, scrubbed result. */
export interface AdapterRunResult {
  /** Which gate (lint/typecheck/unit/...). */
  name: string;
  /** Command line that was executed. */
  command: string;
  /** exit code — 0 means pass. */
  exitCode: number;
  /** Stdout after redaction. */
  stdout: string;
  /** Stderr after redaction. */
  stderr: string;
  /** Wall-clock duration in ms. */
  durationMs: number;
  /** True iff exitCode === 0. */
  passed: boolean;
}

/**
 * Adapter contract — runs a single gate in `workdir` using the supplied
 * executor (so tests don't need a real shell).
 */
export interface GateAdapter {
  readonly name: GateName;
  /** Default command for the gate, e.g. `pnpm -r typecheck`. */
  readonly command: string;
  run(args: {
    workdir: string;
    exec: GateCommandExecutor;
  }): Promise<AdapterRunResult>;
}

/**
 * Executes a command in `workdir` and returns captured output.
 * Production wires this to child_process; tests inject a stub.
 */
export type GateCommandExecutor = (args: {
  command: string;
  cwd: string;
}) => Promise<{ stdout: string; stderr: string; exitCode: number }>;

/** Per-adapter result keyed by gate name. */
export type PerAdapterResults = Record<GateName, AdapterRunResult>;

/** Rolled-up gate output. */
export interface GateResult {
  /** head commit the gate ran against. */
  headSha: Sha;
  /** base commit the gate diffed against. */
  baseSha: Sha;
  /** Repo slug (`owner/repo`). */
  repo: string;
  /** True iff every adapter passed. */
  passed: boolean;
  /** Per-adapter results. */
  adapters: PerAdapterResults;
  /**
   * `sha256:<hex>` binding hash covering canonical(headSha, baseSha,
   * adapterResults). Any tampering with the bound fields changes the hash.
   */
  bindingHash: string;
  /**
   * Artifact key (`sha256:...`) of the rolled-up scrubbed log artifact
   * that was persisted via the ArtifactStore. Callers that need to
   * audit individual adapter output follow this ref.
   */
  logArtifactRef: string;
}

/**
 * The artifact body persisted for the rolled-up gate log. Stored as
 * an `Artifact` of kind `raw_payload` (the only kind the M2 store
 * supports today); the body is canonical JSON so its sha256 is stable.
 */
export interface GateLogArtifactBody {
  kind: 'gate_log';
  headSha: Sha;
  baseSha: Sha;
  repo: string;
  adapters: PerAdapterResults;
}

export type GateLogArtifact = Artifact & { content: string };

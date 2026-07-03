/**
 * Streaming output collector — T-M11-001, spec §13 / §16.
 *
 * Collects streaming SDK events emitted by the in-process Claude Agent
 * SDK into a structured WorkerResultArtifact. The collector is a pure
 * reducer: feed it SDK events via .ingest(event), then call .finalize()
 * to produce the artifact whose patchSha is sha256 over the canonical
 * JSON of the recorded entries (deterministic, audit-chain-friendly).
 *
 * The Collector deliberately reuses the WorkerResultArtifact shape
 * defined in dev/development-module.ts so downstream gates and the dev
 * module cannot tell an Agent-SDK run apart from a CCA run (spec §13:
 * "permission/hooks/artifact/log paths identical").
 */

import { createHash } from 'node:crypto';
import { stableJsonStringify } from '@cgao/schemas';
import type { WorkerResultArtifact } from '../dev/development-module.js';

/**
 * Minimal event shape the collector understands. The real SDK emits a
 * superset; we project down to these fields and ignore everything else.
 * Unknown event kinds are counted as `ignored` for observability.
 */
export interface SdkStreamEvent {
  /** Event kind: 'tool_use' | 'tool_result' | 'message' | 'stop' | <other>. */
  type: string;
  /** Tool name when type='tool_use' (e.g. 'str_replace_editor', 'bash'). */
  tool?: string;
  /** Tool input snapshot — must be PRE-redaction by the runner hook. */
  toolInput?: Record<string, unknown>;
  /** Tool result snapshot (for type='tool_result'). */
  toolResult?: { exitCode?: number; stdout?: string; stderr?: string };
  /** Free-form text payload (for type='message'). */
  text?: string;
  /** Stop reason (for type='stop'): 'end_turn' | 'max_tokens' | 'tool_use'. */
  stopReason?: string;
}

export interface CollectedEntry {
  path: string;
  contents: string;
  deleted: boolean;
}

export interface CollectorFinalizeInput {
  /** Optional explicit changed-files list (overrides tool-derived list). */
  changedFiles?: readonly string[];
  /** Tests run, gathered externally (runner hook owns the test command). */
  testsRun?: readonly { command: string; exitCode: number }[];
}

export class StreamingOutputCollector {
  private readonly entries: CollectedEntry[] = [];
  private readonly testsRun: { command: string; exitCode: number }[] = [];
  private ignored = 0;
  private stopReason: string | null = null;

  ingest(event: SdkStreamEvent): void {
    switch (event.type) {
      case 'tool_use':
        this.ingestToolUse(event);
        break;
      case 'tool_result':
        this.ingestToolResult(event);
        break;
      case 'stop':
        this.stopReason = event.stopReason ?? 'end_turn';
        break;
      case 'message':
        // Message events carry no patch data; ignore but count.
        this.ignored++;
        break;
      default:
        this.ignored++;
    }
  }

  private ingestToolUse(event: SdkStreamEvent): void {
    if (!event.tool || !event.toolInput) return;
    const ti = event.toolInput;
    if (event.tool === 'str_replace_editor') {
      const path = typeof ti.path === 'string' ? ti.path : null;
      const contents = typeof ti.new_str === 'string' ? ti.new_str : '';
      const isDelete = ti.command === 'delete' || ti.command === 'rm';
      if (!path) return;
      this.entries.push({ path, contents, deleted: isDelete });
      return;
    }
    if (event.tool === 'bash') {
      const cmd = typeof ti.command === 'string' ? ti.command : '';
      // Capture test-looking commands so the worker result is informative.
      if (/\b(test|spec|vitest|jest)\b/.test(cmd)) {
        this.testsRun.push({ command: cmd, exitCode: 0 });
      }
    }
  }

  private ingestToolResult(event: SdkStreamEvent): void {
    const r = event.toolResult;
    if (!r) return;
    // If the last tool_use was a test command, patch its exitCode.
    const last = this.testsRun[this.testsRun.length - 1];
    if (last && typeof r.exitCode === 'number') {
      last.exitCode = r.exitCode;
    }
  }

  /**
   * Produce the final WorkerResultArtifact. patchSha is sha256 over the
   * canonical JSON of recorded entries so the hash is deterministic.
   */
  finalize(input: CollectorFinalizeInput = {}): WorkerResultArtifact {
    const changedFiles = input.changedFiles ?? [...new Set(this.entries.map((e) => e.path))].sort();
    const testsRun = input.testsRun ?? [...this.testsRun];
    const canonical = stableJsonStringify({
      entries: this.entries,
      stopReason: this.stopReason,
      ignored: this.ignored,
    });
    const patchSha = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
    return {
      kind: 'worker_result',
      payload: {
        patchSha,
        changedFiles,
        testsRun,
      },
    };
  }

  /** Number of events that were not directly attributable to a patch. */
  get ignoredCount(): number {
    return this.ignored;
  }
}

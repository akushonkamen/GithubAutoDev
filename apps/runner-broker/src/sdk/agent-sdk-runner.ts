/**
 * Agent SDK Runner — T-M11-001, spec §13 / §16.
 *
 * In-process agent runner that executes Claude Agent SDK sessions
 * WITHOUT a GitHub Actions dependency. Mirrors the CCA runner's
 * surface so the orchestrator can dispatch either runner through the
 * same broker contract.
 *
 * Security envelope (must be identical to CCA runner):
 *   - CredentialProfile: UNTRUSTED_CODE only (no IM/GitHub-App secrets)
 *   - Sandbox path policy enforced on every write
 *   - WorkerResult + log artifacts persisted through RunnerHooks
 *   - Log scrubber applied to all persisted text
 *   - Audit chain records every dispatch + denial
 *
 * SDK dependency is loaded lazily via a try/import so tests work
 * without `@anthropic-ai/claude-agent-sdk` installed. Production
 * wires the real SDK in the dispatch path.
 */

import type { ExecutorTaskResult } from '../dev/development-module.js';
import { CredentialProfile } from '../profiles/credential-profile.js';
import { runTokenPresenceTest } from '../profiles/token-presence-test.js';
import { type RunnerHooks, enforceWrite, persistScrubbedLog } from './runner-hooks.js';
import { type SdkStreamEvent, StreamingOutputCollector } from './streaming-output-collector.js';

/**
 * Inputs for a single agent run. The runner is dispatch-idempotent: a
 * given RunInput always produces the same ExecutorTaskResult modulo
 * nondeterminism inside the SDK itself.
 */
export interface AgentRunInput {
  taskId: string;
  /** Prompt body (already resolved from the artifact store by caller). */
  prompt: string;
  /** Path the agent should treat as its workspace root. */
  workspaceRoot: string;
  /** Hook bundle (credential profile, sandbox, audit, store, scrub). */
  hooks: RunnerHooks;
}

/**
 * Injectable SDK transport. Production wires the real
 * `@anthropic-ai/claude-agent-sdk` `query()`; tests wire a fake that
 * replays a recorded event stream.
 */
export interface SdkTransport {
  query(args: {
    prompt: string;
    cwd: string;
    allowedTools: readonly string[];
    model: string;
  }): AsyncIterable<SdkStreamEvent>;
}

/** Lazy loader: returns null when the SDK package isn't installed. */
export type SdkTransportFactory = (model: string) => SdkTransport | null;

let transportFactory: SdkTransportFactory | null = null;

/**
 * Register the SDK transport factory. The orchestrator calls this once
 * at boot if (and only if) the SDK is installed. Tests call it with a
 * fake factory.
 */
export function registerSdkTransportFactory(factory: SdkTransportFactory): void {
  transportFactory = factory;
}

/** For tests: reset the factory to its default (no-op) state. */
export function resetSdkTransportFactory(): void {
  transportFactory = null;
}

/**
 * Try to load the real SDK transport. Returns null when the package is
 * not installed so callers can fall back to the CCA runner. Import is
 * dynamic so a missing dependency never breaks test boot.
 */
export async function tryLoadSdkTransport(model: string): Promise<SdkTransport | null> {
  if (transportFactory) return transportFactory(model);
  try {
    // Dynamic import with a non-literal specifier so TypeScript does
    // NOT try to resolve the package at build time (it's an optional
    // peer dep — absent in tests, present in production installs).
    const moduleName = '@anthropic-ai/claude-agent-sdk';
    const mod = (await import(/* @vite-ignore */ moduleName)) as {
      query?: (args: unknown) => AsyncIterable<SdkStreamEvent>;
    };
    if (typeof mod.query !== 'function') return null;
    const query = mod.query;
    return {
      query(args) {
        return query({
          prompt: args.prompt,
          options: {
            cwd: args.cwd,
            allowedTools: args.allowedTools,
            model,
          },
        });
      },
    };
  } catch {
    return null;
  }
}

export interface AgentRunResult {
  taskResult: ExecutorTaskResult;
  /** WorkerResultArtifact emitted by the collector. */
  artifact: import('../dev/development-module.js').WorkerResultArtifact;
  /** Refs of persisted log artifacts. */
  logRefs: readonly string[];
}

/**
 * Execute one agent run in-process.
 *
 * Invariants enforced before any SDK call:
 *   1. hooks.profile === UNTRUSTED_CODE (fail-closed otherwise).
 *   2. The hook bundle's env (resolved separately by the caller) passes
 *      runTokenPresenceTest. The runner does NOT trust the caller's
 *      assertion; it re-scans the resolved env.
 */
export async function runAgentSdkTask(
  input: AgentRunInput,
  transport: SdkTransport,
  options: {
    model?: string;
    allowedTools?: readonly string[];
    resolvedEnv?: NodeJS.ProcessEnv;
  } = {},
): Promise<AgentRunResult> {
  if (input.hooks.profile !== CredentialProfile.UNTRUSTED_CODE) {
    throw new Error(`AgentSDKRunner refuses non-untrusted profile: ${input.hooks.profile}`);
  }
  if (options.resolvedEnv && !runTokenPresenceTest(options.resolvedEnv)) {
    throw new Error('AgentSDKRunner: resolved env fails token presence test');
  }

  const collector = new StreamingOutputCollector();
  const logRefs: string[] = [];
  let errored: string | null = null;

  try {
    for await (const event of transport.query({
      prompt: input.prompt,
      cwd: input.workspaceRoot,
      allowedTools: options.allowedTools ?? ['str_replace_editor', 'bash'],
      model: options.model ?? 'claude-sonnet-4',
    })) {
      collector.ingest(event);
      // Replay file-producing tool_use events through the hook bundle so
      // the overlay + audit chain stay consistent with the CCA runner.
      if (event.type === 'tool_use' && event.tool === 'str_replace_editor') {
        const path = typeof event.toolInput?.path === 'string' ? event.toolInput.path : null;
        const contents =
          typeof event.toolInput?.new_str === 'string' ? event.toolInput.new_str : '';
        if (path) {
          await enforceWrite(input.hooks, path, contents);
        }
      }
    }
  } catch (err) {
    errored = err instanceof Error ? err.message : String(err);
    const ref = await persistScrubbedLog(input.hooks, errored, 'agent_run.error');
    logRefs.push(ref);
  }

  const stopLog = `agent_run.stop ignored=${collector.ignoredCount}`;
  logRefs.push(await persistScrubbedLog(input.hooks, stopLog, 'agent_run.stop'));

  const artifact = collector.finalize();
  const taskResult: ExecutorTaskResult = {
    taskId: input.taskId,
    status: errored ? 'failed' : 'completed',
    entries: input.hooks.overlay.entriesList().map((e) => ({
      path: e.path,
      contents: e.contents,
      deleted: e.deleted,
    })),
    testsRun: artifact.payload.testsRun,
    error: errored ?? undefined,
  };
  return { taskResult, artifact, logRefs };
}

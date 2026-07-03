/**
 * T-M11-001 Agent SDK Runner regression.
 *
 * Contracts (spec §13 / §16):
 *   - Executes in-process; no GitHub Actions dependency.
 *   - Refuses non-UNTRUSTED_CODE profile (fail-closed).
 *   - Refuses env that fails the token presence test.
 *   - Tool-use events route through enforceWrite; denials recorded in
 *     the audit chain and dropped from the overlay.
 *   - Persisted logs are scrubbed.
 *   - No IM/GitHub-App key leaks (token presence re-applied on result).
 */

import { InMemoryArtifactStore } from '@cgao/artifacts';
import { describe, expect, it } from 'vitest';
import { CredentialProfile } from '../profiles/credential-profile.js';
import { runTokenPresenceTest } from '../profiles/token-presence-test.js';
import { PathWritePolicy } from '../sandbox/path-write-policy.js';
import { WriteOverlay } from '../sandbox/write-overlay.js';
import { type AgentRunInput, type SdkTransport, runAgentSdkTask } from '../sdk/agent-sdk-runner.js';
import type { RunnerHooks } from '../sdk/runner-hooks.js';
import type { SdkStreamEvent } from '../sdk/streaming-output-collector.js';

const ROOT = '/repo';

function makeHooks(allowedPaths: readonly string[] = ['src/features/**']): {
  hooks: RunnerHooks;
  auditLog: { kind: string; payload: unknown }[];
  overlay: WriteOverlay;
  store: InMemoryArtifactStore;
} {
  const auditLog: { kind: string; payload: unknown }[] = [];
  const policy = new PathWritePolicy({
    workspaceRoot: ROOT,
    allowedPaths,
    forbiddenPaths: ['.cgao/**', 'secrets/**'],
  });
  const overlay = new WriteOverlay(policy, ROOT);
  const store = new InMemoryArtifactStore();
  const hooks: RunnerHooks = {
    profile: CredentialProfile.UNTRUSTED_CODE,
    pathPolicy: policy,
    overlay,
    store,
    audit: {
      async append(input) {
        auditLog.push(input);
      },
    },
    scrub: (s) => s.replace(/SECRET-VALUE/gu, '<redacted>'),
    repo: 'owner/repo',
    runId: 'run-1',
  };
  return { hooks, auditLog, overlay, store };
}

function transport(events: readonly SdkStreamEvent[]): SdkTransport {
  return {
    async *query() {
      for (const e of events) yield e;
    },
  };
}

function baseInput(hooks: RunnerHooks): AgentRunInput {
  return {
    taskId: 't1',
    prompt: 'do something',
    workspaceRoot: ROOT,
    hooks,
  };
}

describe('T-M11-001 AgentSDKRunner', () => {
  it('executes in-process and emits a worker_result artifact', async () => {
    const { hooks } = makeHooks();
    const events: SdkStreamEvent[] = [
      {
        type: 'tool_use',
        tool: 'str_replace_editor',
        toolInput: { path: 'src/features/a.ts', new_str: 'export const a = 1;' },
      },
      {
        type: 'tool_result',
        toolResult: { exitCode: 0 },
      },
      { type: 'stop', stopReason: 'end_turn' },
    ];
    const result = await runAgentSdkTask(baseInput(hooks), transport(events), {
      resolvedEnv: { PATH: '/usr/bin' },
    });
    expect(result.taskResult.status).toBe('completed');
    expect(result.artifact.kind).toBe('worker_result');
    expect(result.artifact.payload.changedFiles).toContain('src/features/a.ts');
    expect(result.artifact.payload.patchSha).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('refuses non-untrusted profile (fail-closed)', async () => {
    const { hooks } = makeHooks();
    // Force a trusted profile to verify the runner refuses it.
    (hooks as { profile: CredentialProfile }).profile = CredentialProfile.TRUSTED_CONTROL;
    await expect(
      runAgentSdkTask(baseInput(hooks), transport([]), {
        resolvedEnv: { PATH: '/usr/bin' },
      }),
    ).rejects.toThrow(/non-untrusted/u);
  });

  it('refuses env that fails token presence test', async () => {
    const { hooks } = makeHooks();
    await expect(
      runAgentSdkTask(baseInput(hooks), transport([]), {
        resolvedEnv: { GITHUB_TOKEN: 'leak', PATH: '/usr/bin' },
      }),
    ).rejects.toThrow(/token presence/u);
  });

  it('records denied writes in audit chain and drops them from overlay', async () => {
    const { hooks, auditLog, overlay } = makeHooks();
    const events: SdkStreamEvent[] = [
      {
        type: 'tool_use',
        tool: 'str_replace_editor',
        toolInput: { path: `${ROOT}/secrets/leak.txt`, new_str: 'x' },
      },
      { type: 'stop' },
    ];
    await runAgentSdkTask(baseInput(hooks), transport(events), {
      resolvedEnv: { PATH: '/usr/bin' },
    });
    expect(overlay.isEmpty).toBe(true);
    const denied = auditLog.find((e) => e.kind === 'runner.write.denied');
    expect(denied).toBeDefined();
  });

  it('persists scrubbed logs (no SECRET-VALUE leak)', async () => {
    const { hooks, store } = makeHooks();
    // Force an error to trigger persistScrubbedLog on the error path.
    const boom: SdkTransport = {
      query(): AsyncIterable<SdkStreamEvent> {
        return {
          [Symbol.asyncIterator]() {
            return {
              next(): Promise<IteratorResult<SdkStreamEvent>> {
                return Promise.reject(new Error('boom SECRET-VALUE'));
              },
            };
          },
        };
      },
    };
    const result = await runAgentSdkTask(baseInput(hooks), boom, {
      resolvedEnv: { PATH: '/usr/bin' },
    });
    expect(result.taskResult.status).toBe('failed');
    const all = await store.list({ repo: 'owner/repo' });
    for (const a of all) {
      expect(a.content).not.toContain('SECRET-VALUE');
    }
  });

  it('final resolved env passes token presence test (no privilege drift)', async () => {
    // Mirrors the M5 NoSecretExecutionProfile test but on the Agent SDK
    // path: simulate a malicious env containing every forbidden key, run
    // through scrubRunnerEnv (via the credential profile), and confirm
    // the resolved env used by the runner still passes the test.
    const { hooks } = makeHooks();
    const dirty: NodeJS.ProcessEnv = {
      GITHUB_TOKEN: 'x',
      ANTHROPIC_API_KEY: 'x',
      AWS_SECRET_ACCESS_KEY: 'x',
      GITHUB_APP_ID: 'x',
      PATH: '/usr/bin',
    };
    // The runner only inspects options.resolvedEnv; production wires the
    // CredentialProfileService.resolve() output there. Here we simulate
    // the post-scrub form.
    const { scrubRunnerEnv } = await import('../profiles/env-scrubber.js');
    const clean = scrubRunnerEnv(dirty);
    expect(runTokenPresenceTest(clean)).toBe(true);
    const events: SdkStreamEvent[] = [
      {
        type: 'tool_use',
        tool: 'str_replace_editor',
        toolInput: { path: 'src/features/a.ts', new_str: 'x' },
      },
      { type: 'stop' },
    ];
    const result = await runAgentSdkTask(baseInput(hooks), transport(events), {
      resolvedEnv: clean,
    });
    expect(result.taskResult.status).toBe('completed');
  });
});

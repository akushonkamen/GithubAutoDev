/**
 * Ambient stub for the optional `@anthropic-ai/claude-agent-sdk` peer
 * dependency. The runner loads it dynamically via try/import so tests
 * boot without the package installed; this ambient declaration gives
 * TypeScript a fallback when the package is absent from node_modules.
 *
 * Production installs the SDK separately (it is NOT a hard dependency
 * of @cgao/runner-broker).
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  export interface QueryOptions {
    cwd?: string;
    allowedTools?: readonly string[];
    model?: string;
  }
  export interface QueryArgs {
    prompt: string;
    options?: QueryOptions;
  }
  export type SdkEvent = {
    type: string;
    tool?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: { exitCode?: number; stdout?: string; stderr?: string };
    text?: string;
    stopReason?: string;
  };
  export function query(args: QueryArgs): AsyncIterable<SdkEvent>;
}

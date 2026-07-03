/**
 * Untrusted Code Runner env scrub helper — spec §13.1, AS-06.
 *
 * The runner-broker MUST invoke untrusted code with an env that has
 * been scrubbed of every secret-bearing variable. This helper is the
 * authoritative list — anything missing here is a P0 security bug.
 */

export const FORBIDDEN_RUNNER_ENV_KEYS = [
  // GitHub credentials
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_TOKEN',
  'GITHUB_WEBHOOK_SECRET',
  // CGAO control plane
  'CGAO_CONTROL_TOKEN',
  'CGAO_SIGNING_KEY',
  'CGAO_ARTIFACT_WRITE_TOKEN',
  // IM platform secrets
  'LARK_APP_SECRET',
  'LARK_ENCRYPT_KEY',
  'WECOM_AGENT_SECRET',
  'WECOM_RECEIVE_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_BOT_TOKEN',
  // Cloud provider / generic
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
] as const;

/**
 * Returns a *new* env object with forbidden keys removed. Callers
 * should use the result as the child_process `env` option, never
 * `process.env` directly.
 */
export function scrubRunnerEnv(input: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  const forbidden = new Set<string>(FORBIDDEN_RUNNER_ENV_KEYS);
  for (const [k, v] of Object.entries(input)) {
    if (forbidden.has(k)) continue;
    if (k.endsWith('_SECRET') || k.endsWith('_TOKEN') || k.endsWith('_KEY')) continue;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

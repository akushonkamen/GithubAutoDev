/**
 * Credential profile service — T-M5-003, spec §13 / §17.
 *
 * Trusted Control Runner vs Untrusted Code Runner split. The trusted
 * profile runs GitHub API writes, dispatch, audit; it has the GitHub
 * App token + Anthropic key + artifact write token. The untrusted
 * profile runs the agent against repo code; it has NONE of those.
 *
 * Contracts (spec §13.2):
 *
 *   - trusted:   inject GITHUB_APP_*, ANTHROPIC_API_KEY, CGAO_ARTIFACT_WRITE_TOKEN
 *   - untrusted: scrub all of those; only PATH + NODE_ENV + runner-controlled vars
 *
 * The runner-broker resolves the profile from the job label, then
 * passes the resolved env to child_process.
 */

import { FORBIDDEN_RUNNER_ENV_KEYS } from './env-scrubber.js';
import type { JobLabel } from './job-label.js';

export enum CredentialProfile {
  TRUSTED_CONTROL = 'trusted_control',
  UNTRUSTED_CODE = 'untrusted_code',
}

/**
 * Variables the trusted control runner REQUIRES. Their absence is a
 * configuration error and the broker should fail-closed.
 */
export const TRUSTED_REQUIRED_ENV = [
  'GITHUB_APP_ID',
  'GITHUB_INSTALLATION_TOKEN',
  'ANTHROPIC_API_KEY',
  'CGAO_ARTIFACT_WRITE_TOKEN',
] as const;

/**
 * Minimal env the untrusted runner is allowed to see. Everything else
 * is dropped. Notably NO GITHUB_*, NO ANTHROPIC_*, NO AWS_*.
 */
export const UNTRUSTED_ALLOWED_ENV = [
  'PATH',
  'HOME',
  'NODE_ENV',
  'LANG',
  'LC_ALL',
  'TZ',
  'RUNNER_LABEL',
  'CGAO_RUN_ID',
  'CGAO_TASK_ID',
] as const;

export interface ResolvedProfile {
  /** Job label that drove the resolution. */
  jobLabel: JobLabel;
  /** Profile the job runs under. */
  profile: CredentialProfile;
  /**
   * Env to inject for this job. For trusted: the parent env filtered
   * to required + safe. For untrusted: only UNTRUSTED_ALLOWED_ENV.
   */
  env: NodeJS.ProcessEnv;
  /** Variables that were STRIPPED (audit surface). */
  stripped: readonly string[];
}

export class CredentialProfileService {
  constructor(private readonly parentEnv: NodeJS.ProcessEnv = process.env) {}

  resolve(jobLabel: JobLabel): ResolvedProfile {
    if (isTrusted(jobLabel)) {
      return this.resolveTrusted(jobLabel);
    }
    return this.resolveUntrusted(jobLabel);
  }

  private resolveTrusted(jobLabel: JobLabel): ResolvedProfile {
    const env: NodeJS.ProcessEnv = { ...this.parentEnv };
    // Trusted still STRIPS the broad forbidden list (the controller
    // doesn't get to keep arbitrary secrets either — only what it
    // explicitly needs).
    const stripped: string[] = [];
    for (const key of Object.keys(env)) {
      if (isForbiddenKey(key) && !TRUSTED_REQUIRED_ENV.includes(key as never)) {
        delete env[key];
        stripped.push(key);
      }
    }
    return { jobLabel, profile: CredentialProfile.TRUSTED_CONTROL, env, stripped };
  }

  private resolveUntrusted(jobLabel: JobLabel): ResolvedProfile {
    const env: NodeJS.ProcessEnv = {};
    const allowed = new Set<string>(UNTRUSTED_ALLOWED_ENV);
    const stripped: string[] = [];
    for (const [k, v] of Object.entries(this.parentEnv)) {
      if (allowed.has(k)) {
        if (v !== undefined) env[k] = v;
      } else {
        stripped.push(k);
      }
    }
    env.RUNNER_LABEL = jobLabel;
    return { jobLabel, profile: CredentialProfile.UNTRUSTED_CODE, env, stripped };
  }
}

const TRUSTED_LABELS: ReadonlySet<JobLabel> = new Set([
  'analyst',
  'planner',
  'reviewer',
  'committer',
]);

export function isTrusted(label: JobLabel): boolean {
  return TRUSTED_LABELS.has(label);
}

/** True if the key is on the global forbidden list. */
export function isForbiddenKey(key: string): boolean {
  if ((FORBIDDEN_RUNNER_ENV_KEYS as readonly string[]).includes(key)) return true;
  if (key.endsWith('_SECRET') || key.endsWith('_TOKEN') || key.endsWith('_KEY')) return true;
  if (key.startsWith('AWS_')) return true;
  if (key.startsWith('GITHUB_APP_')) return true;
  return false;
}

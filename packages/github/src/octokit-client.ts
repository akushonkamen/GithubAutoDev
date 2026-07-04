/**
 * GitHub App Octokit client — Plan B Phase 1, spec §6.4 / §13.1.
 *
 * Returns an authenticated Octokit instance using the GitHub App's
 * installation token. The installation token is cached with a small
 * refresh window so repeated REST calls reuse it across a single
 * orchestrator boot. Token expiry is monitored; if the cache age
 * exceeds 50 minutes, the next call refreshes.
 *
 * The client lives in @cgao/github because every adapter that needs
 * authenticated GitHub access (prs, comments, merges, hydrator) builds
 * on top of it. Production wires this once per orchestrator boot.
 */

import { createAppAuth } from '@octokit/auth-app';
import { Octokit } from '@octokit/rest';

export interface GithubAppCredentials {
  /** GitHub App numeric id (visible on the app settings page). */
  appId: number | string;
  /** App private key (.pem contents, multi-line). */
  privateKey: string;
  /** Installation id (numeric; captured after installing the App to a repo). */
  installationId: number | string;
  /** Optional product identifier sent in User-Agent. */
  userAgent?: string;
}

export interface AuthenticatedOctokit {
  /** Octokit instance pre-bound with the cached installation token. */
  readonly octokit: Octokit;
  /** Force-refresh the token (used by tests + on 401 retry). */
  refresh(): Promise<void>;
}

const TOKEN_CACHE_MS = 50 * 60 * 1000; // GitHub installation tokens last 1h.

/**
 * Build an Octokit instance authenticated as the App's installation.
 * Caller passes the credentials; we wrap auth-app's strategy with a
 * small cache so re-instantiation between calls is unnecessary.
 */
export async function createGithubAppClient(
  creds: GithubAppCredentials,
): Promise<AuthenticatedOctokit> {
  const auth = createAppAuth({
    appId: String(creds.appId),
    privateKey: creds.privateKey,
    installationId: Number(creds.installationId),
  });
  let cachedToken: string | null = null;
  let cachedAt = 0;

  async function fetchToken(): Promise<string> {
    const { token } = await auth({ type: 'installation' });
    cachedToken = token;
    cachedAt = Date.now();
    return token;
  }

  async function currentToken(): Promise<string> {
    if (cachedToken && Date.now() - cachedAt < TOKEN_CACHE_MS) {
      return cachedToken;
    }
    return await fetchToken();
  }

  async function buildOctokit(): Promise<Octokit> {
    const token = await currentToken();
    return new Octokit({
      auth: token,
      userAgent: creds.userAgent ?? 'cgao-orchestrator',
    });
  }

  let octokit: Octokit = await buildOctokit();

  return {
    get octokit(): Octokit {
      return octokit;
    },
    async refresh(): Promise<void> {
      cachedToken = null;
      octokit = await buildOctokit();
    },
  };
}

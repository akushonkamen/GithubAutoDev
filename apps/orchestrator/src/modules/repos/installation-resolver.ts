/**
 * Installation resolver — T-M11-003, spec §8 / §15.
 *
 * Resolves a webhook payload to its GitHub App installation. Prefers
 * the `x-github-hook-installation-target-id` header (set by GitHub on
 * every webhook since 2023); falls back to `payload.installation.id`
 * for older clients.
 *
 * Throws when neither is present — fail-closed. A webhook without an
 * installation id cannot be routed safely.
 */

export interface InstallationResolution {
  installationId: number;
  /** Where the id came from. */
  source: 'header' | 'payload';
}

export interface InstallationResolverInput {
  /** Raw webhook headers (lowercased keys). */
  headers: Readonly<Record<string, string>>;
  /** Parsed webhook payload (any shape). */
  payload: { installation?: { id?: number } } | null;
}

export class InstallationResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstallationResolutionError';
  }
}

const HEADER_NAME = 'x-github-hook-installation-target-id';

export function resolveInstallation(input: InstallationResolverInput): InstallationResolution {
  const headerVal = lookupHeader(input.headers, HEADER_NAME);
  if (headerVal !== null) {
    const id = Number.parseInt(headerVal, 10);
    if (Number.isFinite(id) && id > 0) {
      return { installationId: id, source: 'header' };
    }
  }
  const payloadId = input.payload?.installation?.id;
  if (typeof payloadId === 'number' && payloadId > 0) {
    return { installationId: payloadId, source: 'payload' };
  }
  throw new InstallationResolutionError(
    'webhook carries no installation id (header and payload both absent)',
  );
}

function lookupHeader(headers: Readonly<Record<string, string>>, name: string): string | null {
  // Header keys are case-insensitive; normalize.
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return null;
}

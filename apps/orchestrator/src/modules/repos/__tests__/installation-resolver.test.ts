/**
 * T-M11-003 InstallationResolver regression.
 *
 * Contracts (spec §8 / §15):
 *   - Header value takes precedence over payload value.
 *   - Falls back to payload.installation.id when header absent.
 *   - Throws when both are absent (fail-closed).
 */

import { describe, expect, it } from 'vitest';
import { InstallationResolutionError, resolveInstallation } from '../installation-resolver.js';

describe('T-M11-003 InstallationResolver', () => {
  it('prefers x-github-hook-installation-target-id header', () => {
    const r = resolveInstallation({
      headers: { 'x-github-hook-installation-target-id': '12345' },
      payload: { installation: { id: 99999 } },
    });
    expect(r.installationId).toBe(12345);
    expect(r.source).toBe('header');
  });

  it('falls back to payload.installation.id when header absent', () => {
    const r = resolveInstallation({
      headers: {},
      payload: { installation: { id: 67890 } },
    });
    expect(r.installationId).toBe(67890);
    expect(r.source).toBe('payload');
  });

  it('throws when neither header nor payload carries the id', () => {
    expect(() => resolveInstallation({ headers: {}, payload: null })).toThrow(
      InstallationResolutionError,
    );
  });

  it('header lookup is case-insensitive', () => {
    const r = resolveInstallation({
      headers: { 'X-GitHub-Hook-Installation-Target-Id': '42' },
      payload: null,
    });
    expect(r.installationId).toBe(42);
    expect(r.source).toBe('header');
  });
});

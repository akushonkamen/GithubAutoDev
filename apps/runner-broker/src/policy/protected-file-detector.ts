/**
 * Protected file detector — T-M5-007, spec §12.11 / §18.
 *
 * Matches the canonical protected-file globs:
 *
 *   .cgao/**
 *   .claude/**
 *   .github/**
 *   package.json
 *   pnpm-lock.yaml
 *   package-lock.json
 *   yarn.lock
 *   scripts/**
 *
 * Touching any of these forces risk severity to ≥ high (T-M5-007
 * RiskEscalationHook). Deleting any of these is rejected outright
 * by PatchValidator.
 */

const PROTECTED_PATTERNS = [
  '.cgao/**',
  '.claude/**',
  '.github/**',
  'package.json',
  'pnpm-lock.yaml',
  'package-lock.json',
  'yarn.lock',
  'scripts/**',
] as const;

export class ProtectedFileDetector {
  private readonly patterns: readonly string[];

  constructor(patterns: readonly string[] = PROTECTED_PATTERNS) {
    this.patterns = patterns;
  }

  isProtected(rel: string): boolean {
    return this.patterns.some((p) => matchGlob(rel, p));
  }

  /** All protected patterns the relative path matches (audit surface). */
  matchedPatterns(rel: string): string[] {
    return this.patterns.filter((p) => matchGlob(rel, p));
  }
}

function matchGlob(rel: string, pattern: string): boolean {
  if (pattern === rel) return true;
  if (pattern.endsWith('/**')) {
    const prefix = pattern.slice(0, -3);
    return rel === prefix || rel.startsWith(`${prefix}/`);
  }
  return false;
}

export const DEFAULT_PROTECTED_FILE_PATTERNS = PROTECTED_PATTERNS;

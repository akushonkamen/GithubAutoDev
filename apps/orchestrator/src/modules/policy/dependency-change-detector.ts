/**
 * Dependency change detector — T-M7-005, spec §12.11 / §18.
 *
 * Diffs package.json + lockfile between a base and head tree and
 * classifies the change into risk decisions the policy evaluator can
 * act on. The detector is pure: callers supply the two trees.
 *
 * Risk classes:
 *
 *   - dependency_added         → high (new dep requires human approval)
 *   - dependency_removed       → medium (deliberate removal is suspicious)
 *   - manifest_or_lockfile_changed → high (lockfile/manifest out of sync)
 *   - manifest_lockfile_drift  → high (one changed without the other)
 *   - new_preinstall_or_postinstall_script → critical (lifecycle hook = RCE)
 *
 * The detector does NOT run npm/pnpm; it parses the manifest JSON
 * directly so the agent cannot smuggle in scripts via the install
 * lifecycle. Lockfile drift is detected structurally: if package.json
 * changed but the lockfile did not (or vice versa), that's drift.
 */

export type DependencyRiskKind =
  | 'dependency_added'
  | 'dependency_removed'
  | 'manifest_or_lockfile_changed'
  | 'manifest_lockfile_drift'
  | 'critical_prepost_script';

export type DependencyRiskSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface DependencyRiskFinding {
  kind: DependencyRiskKind;
  severity: DependencyRiskSeverity;
  /** Human-readable detail (trusted — only cgao-authored fields). */
  detail: string;
  /** Affected dependency name(s), if applicable. */
  packages?: readonly string[];
}

const MANIFEST_PATHS = new Set(['package.json', 'package-lock.json']);
const LOCKFILE_PATHS = new Set(['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']);

interface ParsedManifest {
  deps: Record<string, string>;
  scripts: Record<string, string>;
}

/**
 * Detect dependency-related risk findings between a base and head tree.
 * `changedFiles` is the patch's file list; `headTree`/`baseTree` map
 * path → contents for the relevant files.
 */
export function detectDependencyChanges(args: {
  changedFiles: readonly string[];
  headTree: ReadonlyMap<string, string>;
  baseTree: ReadonlyMap<string, string>;
}): DependencyRiskFinding[] {
  const findings: DependencyRiskFinding[] = [];
  const changed = new Set(args.changedFiles);

  const manifestChanged = changed.has('package.json');
  const npmLockChanged = changed.has('package-lock.json');
  const pnpmLockChanged = changed.has('pnpm-lock.yaml');
  const yarnLockChanged = changed.has('yarn.lock');
  const anyLockChanged = npmLockChanged || pnpmLockChanged || yarnLockChanged;

  // Drift: manifest without lockfile or vice versa.
  if (manifestChanged && !anyLockChanged) {
    findings.push({
      kind: 'manifest_lockfile_drift',
      severity: 'high',
      detail: 'package.json changed but no lockfile changed (manifest/lockfile drift)',
    });
  }
  if (!manifestChanged && anyLockChanged) {
    findings.push({
      kind: 'manifest_lockfile_drift',
      severity: 'high',
      detail: 'lockfile changed but package.json did not (manifest/lockfile drift)',
    });
  }

  // Any manifest/lockfile touch is itself high until proven otherwise.
  if (manifestChanged || anyLockChanged) {
    findings.push({
      kind: 'manifest_or_lockfile_changed',
      severity: 'high',
      detail: 'dependency manifest or lockfile changed',
      packages: [...changed].filter((p) => MANIFEST_PATHS.has(p) || LOCKFILE_PATHS.has(p)),
    });
  }

  // Parse manifests to find dep adds/removes and lifecycle scripts.
  if (manifestChanged) {
    const before = safeParseManifest(args.baseTree.get('package.json'));
    const after = safeParseManifest(args.headTree.get('package.json'));

    // New preinstall / postinstall script = critical (RCE on install).
    const lifecycle = new Set(['preinstall', 'postinstall']);
    for (const name of lifecycle) {
      const had = before.scripts[name] !== undefined;
      const now = after.scripts[name];
      if (!had && now !== undefined) {
        findings.push({
          kind: 'critical_prepost_script',
          severity: 'critical',
          detail: `new ${name} script detected: lifecycle hook can run arbitrary code at install time`,
        });
      }
    }

    // Diff dependencies + devDependencies + peerDependencies + optionalDependencies.
    const depSections = [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ] as const;
    for (const section of depSections) {
      const beforeDeps = (before.deps as Record<string, Record<string, string>>)[section] ?? {};
      const afterDeps = (after.deps as Record<string, Record<string, string>>)[section] ?? {};
      const allNames = new Set([...Object.keys(beforeDeps), ...Object.keys(afterDeps)]);
      const added: string[] = [];
      const removed: string[] = [];
      for (const name of allNames) {
        if (!(name in beforeDeps) && name in afterDeps) {
          added.push(name);
        } else if (name in beforeDeps && !(name in afterDeps)) {
          removed.push(name);
        }
      }
      if (added.length > 0) {
        findings.push({
          kind: 'dependency_added',
          severity: 'high',
          detail: `dependencies added in ${section}: ${added.join(', ')}`,
          packages: added,
        });
      }
      if (removed.length > 0) {
        findings.push({
          kind: 'dependency_removed',
          severity: 'medium',
          detail: `dependencies removed from ${section}: ${removed.join(', ')}`,
          packages: removed,
        });
      }
    }
  }

  return findings;
}

function safeParseManifest(raw: string | undefined): ParsedManifest {
  if (!raw) return { deps: {}, scripts: {} };
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const deps = pick(obj, [
      'dependencies',
      'devDependencies',
      'peerDependencies',
      'optionalDependencies',
    ]);
    const scripts = (obj.scripts && typeof obj.scripts === 'object'
      ? obj.scripts
      : {}) as Record<string, string>;
    return { deps: deps as Record<string, string>, scripts };
  } catch {
    // Unparseable manifest → treat as empty so we don't blow up the gate.
    return { deps: {}, scripts: {} };
  }
}

function pick(obj: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (k in obj) out[k] = obj[k];
  }
  return out;
}

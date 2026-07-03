/**
 * Write overlay — T-M5-005, spec §13.3.
 *
 * In-memory map of {relative path → contents} representing the diff
 * the agent produced against the read-only base. The PatchExporter
 * walks this map to produce a unified-diff patch (T-M5-006).
 *
 * Every write goes through the PathWritePolicy first; a denied write
 * throws POLICY_DENIED and is NOT recorded in the overlay.
 */

import { join } from 'node:path';
import { type PathWritePolicy, type PolicyCheck, normalizePath } from './path-write-policy.js';

export interface OverlayEntry {
  /** Relative path within the workspace. */
  path: string;
  /** New content (UTF-8). Empty string = deletion. */
  contents: string;
  /** Whether this entry represents a file deletion. */
  deleted: boolean;
}

export interface DeniedWrite {
  path: string;
  reasons: string[];
}

export class WriteOverlay {
  private readonly entries = new Map<string, OverlayEntry>();
  private readonly deniedList: DeniedWrite[] = [];
  private readonly policy: PathWritePolicy;
  private readonly workspaceRoot: string;

  constructor(policy: PathWritePolicy, workspaceRoot: string) {
    this.policy = policy;
    this.workspaceRoot = normalizePath(workspaceRoot);
  }

  /**
   * Record a write. Returns 'allow' on success, 'POLICY_DENIED' if
   * the path was rejected. The denial is also appended to the audit
   * surface (this.denied) for downstream escalation.
   */
  write(absolutePath: string, contents: string): PolicyCheck {
    const check = this.policy.isAllowed(absolutePath);
    if (check.decision === 'POLICY_DENIED') {
      this.deniedList.push({ path: absolutePath, reasons: check.reasons });
      return check;
    }
    const rel = this.toRelative(absolutePath);
    this.entries.set(rel, { path: rel, contents, deleted: false });
    return check;
  }

  /** Record a deletion. Same policy gate as write(). */
  delete(absolutePath: string): PolicyCheck {
    const check = this.policy.isAllowed(absolutePath);
    if (check.decision === 'POLICY_DENIED') {
      this.deniedList.push({ path: absolutePath, reasons: check.reasons });
      return check;
    }
    const rel = this.toRelative(absolutePath);
    this.entries.set(rel, { path: rel, contents: '', deleted: true });
    return check;
  }

  /** Snapshot all entries, sorted by path. */
  entriesList(): readonly OverlayEntry[] {
    return [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /** Snapshot all denied writes, in order of occurrence. */
  get denied(): readonly DeniedWrite[] {
    return this.deniedList;
  }

  /** True iff the overlay has no writes. */
  get isEmpty(): boolean {
    return this.entries.size === 0;
  }

  private toRelative(absolutePath: string): string {
    const norm = normalizePath(absolutePath);
    const prefix = `${this.workspaceRoot}/`;
    if (norm.startsWith(prefix)) return norm.slice(prefix.length);
    // Allow callers to pass already-relative paths.
    return norm;
  }
}

export function overlayRoot(policy: PathWritePolicy, workspaceRoot: string): string {
  void policy;
  return join(workspaceRoot);
}

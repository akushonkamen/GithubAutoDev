/**
 * Patch exporter — T-M5-006, spec §12.6 / §13.3.
 *
 * Walks a WriteOverlay and produces a unified-diff patch. The patch
 * is the only thing the agent emits; it is validated against the
 * plan's allowedPaths before being applied to a clean checkout.
 *
 * The unified-diff format here is the minimal subset git accepts:
 *
 *   diff --git a/<path> b/<path>
 *   --- a/<path>
 *   +++ b/<path>
 *   @@ -1 +1 @@
 *   -<old line>
 *   +<new line>
 *
 * For new files, `--- /dev/null` and the file is added in toto. For
 * deletions, the file is emitted in full and the new side is /dev/null.
 */

import type { OverlayEntry } from './write-overlay.js';

export interface ExportedPatch {
  /** Unified-diff text. */
  text: string;
  /** Files the patch touches (relative paths). */
  changedFiles: readonly string[];
}

/**
 * Export the overlay. `baseContents` maps relative path → current
 * contents (from the read-only base); missing keys are treated as
 * "file did not exist" (creation).
 */
export function exportPatch(
  entries: readonly OverlayEntry[],
  baseContents: ReadonlyMap<string, string> = new Map(),
): ExportedPatch {
  const chunks: string[] = [];
  const changedFiles: string[] = [];
  for (const entry of entries) {
    changedFiles.push(entry.path);
    chunks.push(renderEntry(entry, baseContents.get(entry.path)));
  }
  return { text: chunks.join('\n'), changedFiles };
}

function renderEntry(entry: OverlayEntry, oldContent: string | undefined): string {
  const header = `diff --git a/${entry.path} b/${entry.path}\n`;
  if (entry.deleted) {
    const oldLines = (oldContent ?? '').split('\n');
    const body = oldLines.map((l) => `-${l}`).join('\n');
    return `${header}--- a/${entry.path}\n+++ /dev/null\n${body}`;
  }
  if (oldContent === undefined) {
    const newLines = entry.contents.split('\n');
    const body = newLines.map((l) => `+${l}`).join('\n');
    return `${header}--- /dev/null\n+++ b/${entry.path}\n${body}`;
  }
  // Modified: minimal line-by-line diff (replace all).
  const oldLines = oldContent.split('\n');
  const newLines = entry.contents.split('\n');
  const body = [...oldLines.map((l) => `-${l}`), ...newLines.map((l) => `+${l}`)].join('\n');
  return `${header}--- a/${entry.path}\n+++ b/${entry.path}\n@@ -1,${oldLines.length} +1,${newLines.length} @@\n${body}`;
}

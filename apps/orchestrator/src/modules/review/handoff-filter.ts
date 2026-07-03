/**
 * HandoffFilter — T-M8-005, spec §5 / §12.9.
 *
 * Re-export of the defense-in-depth filter from reviewer-context-builder.
 * Kept as a separate module so tests can import the filter independently
 * of the full context builder, matching the task-list file layout.
 */

export { applyHandoffFilter, NARRATIVE_SENTINEL } from './reviewer-context-builder.js';

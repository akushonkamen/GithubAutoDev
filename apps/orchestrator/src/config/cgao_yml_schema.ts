/**
 * `.cgao.yml` schema surface — T-INTAKE-009, spec §18.
 *
 * The canonical Zod schema lives in `@cgao/schemas`. This file re-exports
 * the parse entrypoint and adds the intake-block helpers the orchestrator
 * modules need (default keywords, mode validation, source resolution).
 *
 * Anything mutating the schema itself belongs in packages/schemas — keep
 * this file as a thin orchestrator-side facade so modules don't reach
 * across package boundaries for raw zod objects.
 */

import { type CgaoConfig, type CgaoIntake, cgaoConfigSchema, loadConfig } from '@cgao/schemas';

export type { CgaoConfig, CgaoIntake };
export { cgaoConfigSchema, loadConfig };

/**
 * The three intake modes, lifted into a TypeScript union so callers
 * can switch exhaustively without importing the zod enum.
 *
 *   auto    — every qualified IM message becomes a candidate issue
 *   confirm — default; the clarifier asks the user before creating
 *   off     — intake disabled at runtime even if the block is present
 */
export const INTAKE_MODES = ['auto', 'confirm', 'off'] as const;
export type IntakeMode = (typeof INTAKE_MODES)[number];

export function assertIntakeMode(value: unknown): asserts value is IntakeMode {
  if (typeof value !== 'string' || !INTAKE_MODES.includes(value as IntakeMode)) {
    throw new Error(
      `invalid intake.mode ${JSON.stringify(value)}; expected one of ${INTAKE_MODES.join('|')}`,
    );
  }
}

/**
 * Per-source intake config resolver. Centralizes the lookup so callers
 * don't poke into the nested config tree by hand (which has historically
 * led to "lark vs wecom" divergence bugs).
 */
export function resolveSourceConfig(
  cfg: CgaoConfig,
  source: 'lark' | 'wecom',
): CgaoConfig['intake']['sources']['lark'] {
  return cfg.intake.sources[source];
}

export function isIntakeEnabled(cfg: CgaoConfig): boolean {
  return cfg.intake.enabled && cfg.intake.mode !== 'off';
}

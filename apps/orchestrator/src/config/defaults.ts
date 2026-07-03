/**
 * Canonical default values for `.cgao.yml` — T-INTAKE-009, spec §18.
 *
 * These match the `.default(...)` calls baked into the zod schema in
 * `@cgao/schemas`. They are repeated here as plain constants so the
 * orchestrator can surface them in CLI help, error messages, and
 * fixtures without round-tripping through `z.parse({})`.
 *
 * Keep these in sync with `packages/schemas/src/config.ts` — if you
 * change a default, change it in both places.
 */

import type { IntakeMode } from './cgao_yml_schema.js';

export const DEFAULT_SCHEMA_VERSION = 1 as const;
export const DEFAULT_INTAKE_MODE: IntakeMode = 'confirm';
export const DEFAULT_INTAKE_ENABLED = false;
export const DEFAULT_LARK_TRIGGER_KEYWORDS = ['建issue', '提需求', '记录', 'bug', '需求'];
export const DEFAULT_WECOM_TRIGGER_KEYWORDS = ['建issue', '提需求', '记录', 'bug', '需求'];
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.75;
export const DEFAULT_MAX_CLARIFY_ROUNDS = 5;
export const DEFAULT_DEDUP_WINDOW_MINUTES = 1440;
export const DEFAULT_DEDUP_KEY = ['source_type', 'external_id', 'content_hash'] as const;
export const DEFAULT_RATE_LIMIT_PER_HOUR = 60;

export const INTAKE_DEFAULTS = {
  enabled: DEFAULT_INTAKE_ENABLED,
  mode: DEFAULT_INTAKE_MODE,
  dedup: {
    window_minutes: DEFAULT_DEDUP_WINDOW_MINUTES,
    key: [...DEFAULT_DEDUP_KEY],
  },
  rate_limit: {
    max_llm_calls_per_repo_per_hour: DEFAULT_RATE_LIMIT_PER_HOUR,
  },
  security: {
    redact_before_llm: true,
    untrusted_envelope: true,
    reject_external_links: true,
  },
} as const;

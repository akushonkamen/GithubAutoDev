/**
 * @cgao/security-tests — Security regression suite (T-M0-004).
 *
 * Hosts the durable, cross-package security tests referenced from
 * attack-scenarios/*.md. Tests live under `src/__tests__/`; shared
 * helpers (env scrub, dedup key, replay builder) live here so they
 * can be imported by future T-M1-006 / T-M5-004 suites.
 */

export {
  buildDedupKey,
  type DedupSubject,
} from './helpers/dedup.js';
export {
  scrubRunnerEnv,
  FORBIDDEN_RUNNER_ENV_KEYS,
} from './helpers/env-scrub.js';
export {
  replayRequest,
  type WebhookRequest,
} from './helpers/replay.js';

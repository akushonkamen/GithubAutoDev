/**
 * Config loader. Reads `.cgao.yml` from repo root (or path override),
 * validates via @cgao/schemas. Throws on unknown keys.
 *
 * Per spec §18, the file is YAML; we accept JSON-superset YAML via js-yaml
 * (added in M1 when the actual server boots). M0 scope: skeleton only.
 */
import { type CgaoConfig, loadConfig } from '@cgao/schemas';

export const DEFAULT_CONFIG_PATH = '.cgao.yml';

export function parseConfig(raw: unknown): CgaoConfig {
  return loadConfig(raw);
}

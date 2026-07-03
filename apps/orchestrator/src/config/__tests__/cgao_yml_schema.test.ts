/**
 * `.cgao.yml` intake schema — T-INTAKE-009.
 *
 * Locks the contract: intake.mode is auto|confirm|off (default confirm),
 * invalid modes are rejected, and the required source fields gate the
 * parse. The three repo-level fixtures under fixtures/config/ round-trip
 * through the parser.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import {
  type CgaoConfig,
  INTAKE_MODES,
  type IntakeMode,
  assertIntakeMode,
  cgaoConfigSchema,
  isIntakeEnabled,
  loadConfig,
  resolveSourceConfig,
} from '../cgao_yml_schema.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_DEDUP_WINDOW_MINUTES,
  DEFAULT_INTAKE_MODE,
  DEFAULT_MAX_CLARIFY_ROUNDS,
} from '../defaults.js';

const fixtureDir = fileURLToPath(new URL('../../../../../fixtures/config', import.meta.url));
function loadFixture(name: string): unknown {
  const raw = readFileSync(join(fixtureDir, name), 'utf8');
  return parseYaml(raw);
}

const baseConfig = {
  schema_version: 1,
  repo: { name: 'cgao/test' },
};

describe('intake.mode (T-INTAKE-009)', () => {
  it('accepts auto, confirm, off', () => {
    for (const mode of INTAKE_MODES) {
      const cfg = loadConfig({ ...baseConfig, intake: { enabled: true, mode } });
      expect(cfg.intake.mode).toBe(mode);
    }
  });

  it('defaults to confirm when mode is omitted', () => {
    const cfg = loadConfig({ ...baseConfig, intake: { enabled: true } });
    expect(cfg.intake.mode).toBe(DEFAULT_INTAKE_MODE);
    expect(DEFAULT_INTAKE_MODE).toBe('confirm');
  });

  it('rejects an invalid mode', () => {
    expect(() =>
      loadConfig({ ...baseConfig, intake: { enabled: true, mode: 'always' } }),
    ).toThrow();
  });

  it('rejects a non-string mode', () => {
    expect(() => loadConfig({ ...baseConfig, intake: { enabled: true, mode: 42 } })).toThrow();
  });

  it('rejects a config missing the repo block', () => {
    expect(() => loadConfig({ schema_version: 1 })).toThrow();
  });
});

describe('assertIntakeMode (T-INTAKE-009)', () => {
  it('passes for valid modes and narrows the type', () => {
    for (const mode of INTAKE_MODES) {
      expect(() => assertIntakeMode(mode)).not.toThrow();
    }
    const m: unknown = 'auto';
    assertIntakeMode(m);
    const _check: IntakeMode = m; // narrowed
    expect(_check).toBe('auto');
  });

  it('throws for an invalid mode', () => {
    expect(() => assertIntakeMode('always')).toThrow(/invalid intake\.mode/);
  });
});

describe('intake defaults (T-INTAKE-009)', () => {
  it('fills the default trigger keywords, threshold, and dedup window', () => {
    const cfg = loadConfig({
      ...baseConfig,
      intake: {
        enabled: true,
        sources: {
          lark: { enabled: true, triggers: { at_bot_only: false } },
          wecom: { enabled: true, triggers: { at_bot_only: false } },
        },
      },
    });
    expect(cfg.intake.sources.lark.llm.confidence_threshold).toBe(DEFAULT_CONFIDENCE_THRESHOLD);
    expect(cfg.intake.sources.lark.llm.max_clarify_rounds).toBe(DEFAULT_MAX_CLARIFY_ROUNDS);
    expect(cfg.intake.sources.wecom.llm.max_clarify_rounds).toBe(DEFAULT_MAX_CLARIFY_ROUNDS);
    expect(cfg.intake.dedup.window_minutes).toBe(DEFAULT_DEDUP_WINDOW_MINUTES);
  });
});

describe('isIntakeEnabled (T-INTAKE-009)', () => {
  it('returns true only when enabled && mode !== off', () => {
    expect(
      isIntakeEnabled(loadConfig({ ...baseConfig, intake: { enabled: true, mode: 'auto' } })),
    ).toBe(true);
    expect(
      isIntakeEnabled(loadConfig({ ...baseConfig, intake: { enabled: true, mode: 'confirm' } })),
    ).toBe(true);
    expect(
      isIntakeEnabled(loadConfig({ ...baseConfig, intake: { enabled: true, mode: 'off' } })),
    ).toBe(false);
    expect(
      isIntakeEnabled(loadConfig({ ...baseConfig, intake: { enabled: false, mode: 'auto' } })),
    ).toBe(false);
  });
});

describe('resolveSourceConfig (T-INTAKE-009)', () => {
  it('returns per-source config for lark and wecom', () => {
    const cfg = loadConfig({
      ...baseConfig,
      intake: {
        enabled: true,
        sources: {
          lark: { enabled: true, app_id: 'cli_x', triggers: { at_bot_only: true } },
          wecom: { enabled: false, triggers: { at_bot_only: true } },
        },
      },
    });
    expect(resolveSourceConfig(cfg, 'lark').enabled).toBe(true);
    expect(resolveSourceConfig(cfg, 'wecom').enabled).toBe(false);
  });
});

describe('fixtures round-trip (T-INTAKE-009)', () => {
  it('parses intake_auto.yml with mode=auto', () => {
    const cfg: CgaoConfig = loadConfig(loadFixture('intake_auto.yml'));
    expect(cfg.intake.mode).toBe('auto');
    expect(cfg.intake.enabled).toBe(true);
  });

  it('parses intake_confirm.yml with mode=confirm', () => {
    const cfg: CgaoConfig = loadConfig(loadFixture('intake_confirm.yml'));
    expect(cfg.intake.mode).toBe('confirm');
    expect(cfg.intake.enabled).toBe(true);
  });

  it('parses intake_off.yml with mode=off and disabled sources', () => {
    const cfg: CgaoConfig = loadConfig(loadFixture('intake_off.yml'));
    expect(cfg.intake.mode).toBe('off');
    expect(cfg.intake.enabled).toBe(false);
    expect(cfg.intake.sources.lark.enabled).toBe(false);
    expect(cfg.intake.sources.wecom.enabled).toBe(false);
  });
});

describe('cgaoConfigSchema unknown keys (T-INTAKE-009)', () => {
  it('rejects unknown top-level keys', () => {
    expect(() =>
      cgaoConfigSchema.parse({
        ...baseConfig,
        surprise: true,
      }),
    ).toThrow();
  });
});

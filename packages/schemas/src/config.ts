/**
 * @cgao/schemas — Zod schemas for config, Artifact, audit records.
 *
 * Config schema mirrors spec §18 (cgao_v3). Artifact schemas mirror §11.
 */
import { z } from 'zod';

export const cgaoConfigSchema = z
  .object({
    schema_version: z.literal(1),
    repo: z.object({
      name: z.string().min(1),
      default_branch: z.string().default('main'),
    }),
    // spec §4.5 SHA-bound gate defaults
    gates: z
      .object({
        spec_sha: z.boolean().default(true),
        plan_sha: z.boolean().default(true),
        approval_sha: z.boolean().default(true),
        head_sha: z.boolean().default(true),
        base_sha: z.boolean().default(true),
      })
      .default({}),
    // spec §13.1 runner permission domains
    runners: z
      .object({
        trusted_control: z
          .object({
            label: z.string().default('cgao-trusted-runner'),
            allowed_secrets: z
              .array(z.string())
              .default([
                'CGAO_CONTROL_TOKEN',
                'GITHUB_APP_KEY',
                'GITHUB_APP_ID',
                'LARK_APP_SECRET',
                'WECOM_CORP_ID',
                'WECOM_AGENT_SECRET',
                'WECOM_TOKEN',
                'WECOM_ENCODING_AES_KEY',
              ]),
          })
          .default({}),
        untrusted_code: z
          .object({
            label: z.string().default('cgao-untrusted-runner'),
            // Hardcoded: NO secret allowlist for untrusted code runner.
            allowed_secrets: z.array(z.string()).max(0).default([]),
          })
          .default({}),
      })
      .default({}),
    // spec §18 intake block (v3)
    intake: z
      .object({
        enabled: z.boolean().default(false),
        mode: z.enum(['auto', 'confirm', 'off']).default('confirm'),
        sources: z
          .object({
            lark: z
              .object({
                enabled: z.boolean().default(false),
                app_id: z.string().optional(),
                triggers: z
                  .object({
                    at_bot_only: z.boolean().default(false),
                    explicit_keywords: z
                      .array(z.string())
                      .default(['建issue', '提需求', '记录', 'bug', '需求']),
                  })
                  .default({}),
                llm: z
                  .object({
                    confidence_threshold: z.number().min(0).max(1).default(0.75),
                    max_clarify_rounds: z.number().int().min(1).max(10).default(5),
                  })
                  .default({}),
              })
              .default({}),
            wecom: z
              .object({
                enabled: z.boolean().default(false),
                corp_id: z.string().optional(),
                triggers: z
                  .object({
                    at_bot_only: z.boolean().default(false),
                    explicit_keywords: z
                      .array(z.string())
                      .default(['建issue', '提需求', '记录', 'bug', '需求']),
                  })
                  .default({}),
                llm: z
                  .object({
                    confidence_threshold: z.number().min(0).max(1).default(0.75),
                    max_clarify_rounds: z.number().int().min(1).max(10).default(5),
                  })
                  .default({}),
              })
              .default({}),
          })
          .default({}),
        dedup: z
          .object({
            window_minutes: z.number().int().min(1).default(1440),
            key: z
              .array(z.string())
              .min(3)
              .max(3)
              .default(['source_type', 'external_id', 'content_hash']),
          })
          .default({}),
        rate_limit: z
          .object({
            max_llm_calls_per_repo_per_hour: z.number().int().min(0).default(60),
          })
          .default({}),
        security: z
          .object({
            redact_before_llm: z.boolean().default(true),
            untrusted_envelope: z.boolean().default(true),
            reject_external_links: z.boolean().default(true),
          })
          .default({}),
      })
      .default({}),
  })
  // reject unknown top-level keys
  .strict();

export type CgaoConfig = z.infer<typeof cgaoConfigSchema>;
export type CgaoIntake = CgaoConfig['intake'];
export type CgaoIntakeMode = CgaoIntake['mode'];

export function loadConfig(raw: unknown): CgaoConfig {
  return cgaoConfigSchema.parse(raw);
}

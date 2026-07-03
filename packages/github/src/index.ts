/**
 * @cgao/github — GitHub webhook payload types and signature verification.
 *
 * Per spec §12.1. Owns the *ingress* surface: typed payload shapes for the
 * events CGAO subscribes to, and the X-Hub-Signature-256 verification that
 * MUST run on the Trusted Control Runner (spec §6.4, AS-01).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

export const githubWebhookEventSchema = z.object({
  'x-github-event': z.string().min(1),
  'x-github-delivery': z.string().uuid(),
  'x-hub-signature-256': z.string().min(1),
});

export type GithubWebhookHeaders = z.infer<typeof githubWebhookEventSchema>;

/**
 * Verify an incoming webhook signature against the GitHub App webhook secret.
 * MUST be called on the Trusted Control Runner (spec §6.4, AS-01). Constant-time
 * comparison to prevent timing oracle.
 *
 * Returns true iff the signature matches `sha256=<hmac>`.
 */
export function verifyGithubSignature(
  body: string,
  signatureHeader: string,
  secret: string,
): boolean {
  const expected = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  if (expected.length !== signatureHeader.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader));
  } catch {
    return false;
  }
}

/** Minimal issue opened payload shape (only fields CGAO reads). */
export const issueOpenedPayloadSchema = z.object({
  action: z.literal('opened'),
  issue: z.object({
    number: z.number().int().positive(),
    title: z.string(),
    body: z.string().nullable(),
    html_url: z.string().url(),
  }),
  repository: z.object({
    name: z.string(),
    full_name: z.string(),
    owner: z.object({ login: z.string() }),
  }),
});

export type IssueOpenedPayload = z.infer<typeof issueOpenedPayloadSchema>;

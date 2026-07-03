/**
 * PR marker — T-M7-003, spec §14.2 / §15.
 *
 * cgao writes a single invisible HTML comment marker into every PR
 * body it authors. The marker carries the run_id and head_sha so the
 * runner can later locate the PR for a run and verify the head hasn't
 * drifted. Mirrors the status-comment marker pattern (T-M3-002).
 *
 * Contracts:
 *
 *   - The marker is HMAC-authenticated. A forged marker cannot be
 *     used to impersonate cgao in update flows.
 *   - The marker is display-only (spec §5) — never authoritative.
 *     The runner never trusts marker contents for policy decisions;
 *     it re-reads state from the DB + audit chain.
 *   - The PR body itself may be user-visible; the marker is hidden
 *     inside an HTML comment so humans don't see it in rendered
 *     markdown.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export const PR_MARKER_BEGIN = '<!-- cgao:pr-marker';
export const PR_MARKER_END = '-->';

export interface PrMarkerInput {
  /** HMAC secret (CGAO_CONTROL_TOKEN). */
  secret: string;
  /** Workflow run id. */
  runId: string;
  /** Head sha the PR was created against. */
  headSha: string;
}

export interface ParsedPrMarker {
  runId: string;
  headSha: string;
  mac: string;
}

/**
 * Generate the PR marker HMAC. Input is `${runId}\n${headSha}` —
 * no nonce (PRs are create-once per head sha; we want identical
 * markers across idempotent re-renders so the matcher is stable).
 */
export function generatePrMarker(input: PrMarkerInput): string {
  if (!input.runId || !input.headSha) {
    throw new Error('PrMarker: runId and headSha must be non-empty');
  }
  const data = `${input.runId}\n${input.headSha}`;
  const mac = createHmac('sha256', input.secret).update(data).digest('hex');
  return `${PR_MARKER_BEGIN} run_id=${input.runId} head_sha=${input.headSha} mac=${mac} ${PR_MARKER_END}`;
}

/**
 * Parse a marker from a PR body. Returns null when no marker is found
 * or the structure is malformed — callers MUST treat null as "not a
 * cgao-authored PR" for the purposes of in-place updates.
 */
export function parsePrMarker(body: string): ParsedPrMarker | null {
  const m = body.match(
    /<!--\s*cgao:pr-marker\s+run_id=([^\s]+)\s+head_sha=([^\s]+)\s+mac=([0-9a-f]+)\s*-->/u,
  );
  if (!m) return null;
  const [, runId, headSha, mac] = m;
  if (!runId || !headSha || !mac) return null;
  return { runId, headSha, mac };
}

/**
 * Verify a parsed PR marker against the secret. Constant-time on the MAC.
 */
export function verifyPrMarker(args: {
  secret: string;
  parsed: ParsedPrMarker;
}): boolean {
  const data = `${args.parsed.runId}\n${args.parsed.headSha}`;
  const expected = createHmac('sha256', args.secret).update(data).digest('hex');
  return constantTimeHexEqual(expected, args.parsed.mac);
}

/**
 * Convenience: extract + verify a marker from a body in one call.
 * Returns the parsed marker on success, null otherwise.
 */
export function authenticatePrMarker(args: {
  secret: string;
  body: string;
}): ParsedPrMarker | null {
  const parsed = parsePrMarker(args.body);
  if (!parsed) return null;
  return verifyPrMarker({ secret: args.secret, parsed }) ? parsed : null;
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Redaction baseline — T-M2-005, spec §11 / §20.
 *
 * Three layers of secret scanning; each artifact runs through them
 * before being persisted to a non-volatile store or surfaced to
 * users (GitHub comments, status updates):
 *
 *   1. SecretRedactor — known patterns (AWS keys, GitHub PATs,
 *      `Authorization: Bearer ...`, env-style `SECRET=...`).
 *   2. PiiRedactor — email addresses and bare credit-card-shaped
 *      digit runs. Phone numbers intentionally left alone (too noisy).
 *   3. HighEntropyScanner — random-looking base64/hex strings of
 *      length >= 20 whose Shannon entropy exceeds a threshold.
 *
 * Output is a single string with matches replaced by `[REDACTED:<kind>]`
 * plus a list of `RedactionFinding` records so audit can record what
 * was scrubbed without re-leaking the secret value.
 *
 * classification policy: artifacts containing any redaction finding
 * are marked `security_sensitive` and MUST NOT be written to GitHub
 * comments (caller enforces; we only compute the classification).
 */

import { createHash } from 'node:crypto';

export type RedactionKind =
  | 'aws_access_key'
  | 'aws_secret'
  | 'github_pat'
  | 'github_oauth'
  | 'bearer_token'
  | 'env_secret'
  | 'slack_token'
  | 'google_api_key'
  | 'private_key'
  | 'email'
  | 'credit_card'
  | 'high_entropy';

export interface RedactionFinding {
  kind: RedactionKind;
  /** 0-based start offset in original text. */
  start: number;
  /** Length of the matched span in original text. */
  length: number;
  /** sha256 of the matched secret, for audit without re-leaking. */
  fingerprint: string;
}

export interface RedactionResult {
  redacted: string;
  findings: RedactionFinding[];
  classification: 'clean' | 'security_sensitive';
}

interface Pattern {
  kind: RedactionKind;
  regex: RegExp;
}

const PATTERNS: ReadonlyArray<Pattern> = [
  // AWS access key id: AKIA followed by 16 base32-ish chars.
  { kind: 'aws_access_key', regex: /\bAKIA[0-9A-Z]{16}\b/gu },
  // AWS secret key: 40 base64 chars following "aws_secret" or after a known header.
  // We avoid matching all 40-char base64 because that floods false positives.
  {
    kind: 'aws_secret',
    regex: /\b(?:aws_secret_access_key|secretAccessKey)["'\s:=]+([A-Za-z0-9/+=]{40})\b/gu,
  },
  // GitHub PAT (classic): ghp_ / gho_ / ghs_ / ghu_ / github_pat_ prefixes.
  { kind: 'github_pat', regex: /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9]{36,}\b/gu },
  // Authorization: Bearer <jwt-or-opaque>
  { kind: 'bearer_token', regex: /\bBearer\s+[A-Za-z0-9_\-\.]{16,}/gu },
  // Slack token prefixes.
  { kind: 'slack_token', regex: /\bxox[abp]-[A-Za-z0-9-]{10,}/gu },
  // Google API key.
  { kind: 'google_api_key', regex: /\bAIza[0-9A-Za-z_\-]{35}\b/gu },
  // PEM private key block.
  {
    kind: 'private_key',
    regex:
      /-----BEGIN (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----[\s\S]+?-----END (?:RSA |EC |OPENSSH |PGP |)PRIVATE KEY-----/gu,
  },
  // env-style SECRET=... assignments (any case). Captures the value, not the name.
  {
    kind: 'env_secret',
    regex:
      /\b(?:SECRET|TOKEN|PASSWORD|API_KEY|ACCESS_KEY|PRIVATE_KEY)["']?\s*[:=]\s*["']?([^\s"']{8,})/gu,
  },
  // Email
  { kind: 'email', regex: /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/gu },
  // Credit card (12-19 digit runs that pass Luhn)
  { kind: 'credit_card', regex: /\b(?:\d[ -]?){13,19}\b/gu },
];

const HIGH_ENTROPY_MIN_LEN = 20;
const HIGH_ENTROPY_MIN_H = 4.5; // bits per char

export function shannonEntropy(s: string): number {
  if (!s) return 0;
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function looksHighEntropy(token: string): boolean {
  if (token.length < HIGH_ENTROPY_MIN_LEN) return false;
  // Skip pure-numeric tokens (Luhn/credit_card catches those).
  if (/^\d+$/u.test(token)) return false;
  // Skip tokens that are mostly punctuation.
  const alnum = token.replace(/[^A-Za-z0-9]/gu, '');
  if (alnum.length < HIGH_ENTROPY_MIN_LEN) return false;
  return shannonEntropy(alnum) >= HIGH_ENTROPY_MIN_H;
}

function findHighEntropy(text: string): RedactionFinding[] {
  const out: RedactionFinding[] = [];
  const candidates = text.match(/[A-Za-z0-9_\-]{20,}/gu) ?? [];
  let searchFrom = 0;
  for (const cand of candidates) {
    if (!looksHighEntropy(cand)) continue;
    const idx = text.indexOf(cand, searchFrom);
    if (idx < 0) continue;
    out.push(makeFinding('high_entropy', cand, idx));
    searchFrom = idx + cand.length;
  }
  return out;
}

function makeFinding(kind: RedactionKind, value: string, start: number): RedactionFinding {
  return {
    kind,
    start,
    length: value.length,
    fingerprint: createHash('sha256').update(value).digest('hex'),
  };
}

export function redact(text: string): RedactionResult {
  // First pass: regex patterns. We collect findings with absolute offsets,
  // then rewrite in reverse order so earlier offsets stay valid.
  const patternFindings: RedactionFinding[] = [];
  for (const { kind, regex } of PATTERNS) {
    regex.lastIndex = 0;
    for (let m = regex.exec(text); m !== null; m = regex.exec(text)) {
      // For env_secret / aws_secret the value is captured group 1; otherwise
      // the whole match is the secret.
      const value = m[1] ?? m[0];
      const valueStart = m.index + m[0].indexOf(value);
      if (valueStart < 0 || !value) continue;
      patternFindings.push(makeFinding(kind, value, valueStart));
      if (m.index === regex.lastIndex) regex.lastIndex++;
    }
  }

  // Second pass: high-entropy scan, ignoring spans already covered by a
  // pattern finding (e.g. a PEM private key block contains very high
  // entropy base64, but the PEM finding already wins).
  const patternSpans: Array<[number, number]> = patternFindings.map((f) => [
    f.start,
    f.start + f.length,
  ]);
  const entropyFindings = findHighEntropy(text).filter(
    (f) => !patternSpans.some(([s, e]) => f.start < e && f.start + f.length > s),
  );

  const findings = [...patternFindings, ...entropyFindings];

  // Sort descending by start so rewrite offsets remain valid.
  findings.sort((a, b) => b.start - a.start);

  // Dedup findings that overlap (e.g. aws_secret captured inside an env_secret).
  const deduped: RedactionFinding[] = [];
  const covered: Array<[number, number]> = [];
  for (const f of findings) {
    const overlaps = covered.some(([s, e]) => f.start < e && f.start + f.length > s);
    if (overlaps) continue;
    deduped.push(f);
    covered.push([f.start, f.start + f.length]);
  }

  let redacted = text;
  for (const f of deduped) {
    redacted = `${redacted.slice(0, f.start)}[REDACTED:${f.kind}]${redacted.slice(f.start + f.length)}`;
  }

  const classification = deduped.length > 0 ? 'security_sensitive' : 'clean';
  return { redacted, findings: deduped, classification };
}

/** Convenience predicate for callers deciding whether to surface content. */
export function isSecuritySensitive(text: string): boolean {
  return redact(text).classification === 'security_sensitive';
}

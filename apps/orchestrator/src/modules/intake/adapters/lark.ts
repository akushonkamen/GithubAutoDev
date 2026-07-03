/**
 * Lark adapter — T-INTAKE-001, spec §12.0 / §17.4.
 *
 * Responsibilities:
 *
 *   verifySignature(rawBody, signature, timestamp) — timing-safe HMAC
 *     of the raw request body against the configured verification
 *     secret. MUST run only on the Trusted Control Runner; the
 *     Untrusted Code Runner is forbidden from holding the secret.
 *
 *   normalizeEvent(payload) — translate Lark's IM message events into
 *     cgao's IntakeEvent shape so downstream code doesn't care which
 *     platform produced it.
 *
 *   extractMentions(payload) — return the list of user mentions
 *     (open_id + name) so the classifier can check for the bot.
 *
 *   sendMessage(...) — actual POST to Lark API lives here. Stubbed
 *     for unit tests; production injects a fetch-shaped dependency.
 */

import { createDecipheriv, createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface LarkVerificationConfig {
  /** Verification token from Lark developer console. */
  verificationToken: string;
  /** Optional AES-256 encrypt key, if encrypt mode is enabled. */
  encryptKey?: string;
}

export interface LarkEventEnvelope {
  /** Lark's challenge / url verification flow. */
  challenge?: string;
  /** Event type, e.g. im.message.receive_v1. */
  type?: string;
  header?: {
    event_type?: string;
    token?: string;
    event_id?: string;
    create_time?: string;
  };
  event?: LarkImMessageEvent;
  /** Encrypted payload, when encrypt mode is on. */
  encrypt?: string;
}

export interface LarkImMessageEvent {
  sender?: {
    sender_id?: { open_id?: string; user_id?: string; union_id?: string };
    sender_type?: string;
  };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: 'p2p' | 'group';
    message_type?: string;
    content?: string;
    mentions?: Array<{ key: string; id: { open_id?: string; name?: string } }>;
    create_time?: string;
  };
}

export interface IntakeEvent {
  sourceType: 'lark';
  externalId: string;
  sender: {
    /** Stable Lark open_id; never a display name (spoofable). */
    openId: string;
    /** Display name as Lark reported it (NOT authoritative identity). */
    displayName: string;
  };
  chatId: string;
  chatType: 'p2p' | 'group';
  text: string;
  mentions: Array<{ id: string; name: string }>;
  receivedAt: string;
}

const HMAC_ALGO = 'sha256';

/**
 * Lark sign: HMAC-SHA256(verificationToken, `${timestamp}\n${rawBody}`).
 * The computed digest is compared to `signature` using timingSafeEqual
 * to defeat timing oracles. Returns true when the request is authentic.
 *
 * The raw body is the *exact bytes* Lark POSTed (no re-serialization).
 * Callers MUST pass the bytes verbatim — re-stringified JSON changes
 * whitespace and breaks the signature.
 */
export function verifyLarkSignature(args: {
  rawBody: string;
  signature: string;
  timestamp: string;
  config: LarkVerificationConfig;
}): boolean {
  if (!args.signature || !args.timestamp) return false;
  const data = `${args.timestamp}\n${args.rawBody}`;
  const expected = createHmacHex(args.config.verificationToken, data);
  return constantTimeHexEqual(expected, args.signature);
}

/**
 * Decrypt Lark's encrypt-mode payload using AES-256-CBC with the key
 * derived from sha256(encryptKey). Returns the inner JSON.
 */
export function decryptLarkPayload(args: {
  encrypt: string;
  config: LarkVerificationConfig;
}): LarkEventEnvelope {
  if (!args.config.encryptKey) throw new Error('lark encryptKey not configured');
  const key = createHash('sha256').update(args.config.encryptKey).digest();
  // Lark's encrypted format: base64({ iv(16) || ciphertext }) with the
  // fernet-ish layout. We only implement the AES-256-CBC core here.
  const buf = Buffer.from(args.encrypt, 'base64');
  if (buf.length < 32) throw new Error('lark encrypt payload too short');
  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  // ECB on each 16-byte block via createDecipheriv('aes-256-cbc').
  const dec = decodeAesCbc(key, iv, ct);
  return JSON.parse(dec) as LarkEventEnvelope;
}

export function normalizeLarkEvent(
  env: LarkEventEnvelope,
  now: Date = new Date(),
): IntakeEvent | null {
  if (!env.event?.message || !env.event.sender) return null;
  const m = env.event.message;
  const s = env.event.sender;
  const openId = s.sender_id?.open_id ?? '';
  if (!openId) return null;
  const messageId = m.message_id ?? '';
  if (!messageId) return null;
  const text = extractLarkText(m.content ?? '', m.message_type ?? 'text');
  const mentions = (m.mentions ?? []).map((x) => ({
    id: x.id?.open_id ?? '',
    name: x.id?.name ?? '',
  }));
  return {
    sourceType: 'lark',
    externalId: `${m.chat_id ?? ''}:${messageId}`,
    sender: { openId, displayName: '' },
    chatId: m.chat_id ?? '',
    chatType: m.chat_type ?? 'p2p',
    text,
    mentions,
    receivedAt: now.toISOString(),
  };
}

export function extractLarkMentions(env: LarkEventEnvelope): Array<{ id: string; name: string }> {
  return (env.event?.message?.mentions ?? []).map((m) => ({
    id: m.id?.open_id ?? '',
    name: m.id?.name ?? '',
  }));
}

/** Parse the Lark message content envelope (a JSON string) into plain text. */
function extractLarkText(content: string, type: string): string {
  if (type !== 'text' || !content) return content ?? '';
  try {
    const parsed = JSON.parse(content) as { text?: string };
    return parsed.text ?? content;
  } catch {
    return content;
  }
}

export type LarkSendFn = (args: { chatId: string; text: string }) => Promise<void>;

export class LarkAdapter {
  constructor(
    private readonly config: LarkVerificationConfig,
    private readonly send?: LarkSendFn,
  ) {}

  verifySignature(args: {
    rawBody: string;
    signature: string;
    timestamp: string;
  }): boolean {
    return verifyLarkSignature({ ...args, config: this.config });
  }

  async sendMessage(args: { chatId: string; text: string }): Promise<void> {
    if (!this.send) throw new Error('lark send fn not configured');
    return this.send(args);
  }
}

// --- crypto helpers ---

function createHmacHex(secret: string, data: string): string {
  return createHmac(HMAC_ALGO, secret).update(data).digest('hex');
}

function decodeAesCbc(key: Buffer, iv: Buffer, ct: Buffer): string {
  const d = createDecipheriv('aes-256-cbc', key, iv);
  // autoPadding=true (default) strips PKCS7 padding via final().
  const raw = Buffer.concat([d.update(ct), d.final()]);
  return raw.toString('utf8');
}

function constantTimeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, 'hex');
  const bb = Buffer.from(b, 'hex');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

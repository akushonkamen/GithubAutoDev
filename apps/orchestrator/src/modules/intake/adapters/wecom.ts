/**
 * WeCom (WeChat Work) adapter — T-INTAKE-002, spec §12.0 / §17.5.
 *
 * Verification algorithm (msg_signature):
 *   msg_signature = sha1(sort([token, timestamp, nonce, msg_encrypt]).join(''))
 *
 * Only the Trusted Control Runner holds the corp id + agent secret.
 * The orchestrator forwards the raw incoming request to the Trusted
 * Control Runner job which:
 *   1. Calls verifyWecomSignature — refuses on mismatch.
 *   2. Calls decryptWecomPayload (AES-256-CBC, key=sha256(corpid + secret)
 *      base64-decoded first 32 bytes... actually WeCom derives via
 *      base64-decoded(sha1(corpid_secret))[:32] — see wecom docs).
 *   3. Calls normalizeWecomEvent and feeds the result into the intake
 *      pipeline (classifier → clarifier → issuer).
 */

import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';

export interface WecomVerificationConfig {
  /** Random token set when registering the callback. */
  token: string;
  /** AES key base64-encoded, also set at callback registration. */
  encodingAesKey: string;
  /** WeCom corp id; mixed into the AES key derivation. */
  corpId: string;
  /** Agent secret. NEVER loaded on Untrusted Code Runner. */
  agentSecret: string;
}

export interface WecomEventEnvelope {
  msg_signature?: string;
  timestamp?: string;
  nonce?: string;
  echostr?: string;
  /** Encrypted payload, base64. */
  encrypt?: string;
  ToUserName?: string;
  AgentID?: string;
}

export interface WecomMessageEvent {
  MsgType?: string;
  Content?: string;
  MsgId?: number | string;
  FromUserName?: string;
  ChatId?: string;
  ChatType?: string;
  CreateTime?: number;
}

/**
 * Verify msg_signature = sha1(sort(token, timestamp, nonce, msg_encrypt)).
 * Timing-safe comparison of hex-encoded digests.
 */
export function verifyWecomSignature(args: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean {
  const parts = [args.token, args.timestamp, args.nonce, args.encrypt].sort();
  const sorted = parts.join('');
  const expected = createHash('sha1').update(sorted).digest('hex');
  return constantTimeStringEqual(expected, args.signature);
}

/** Derive the AES-256-CBC key from the encoding AES key base64 string. */
export function deriveWecomAesKey(encodingAesKey: string): Buffer {
  // WeCom's encoding AES key is base64-encoded and represents 43 chars
  // which decodes to 32 bytes when the key already includes padding.
  // Real WeCom keys are 43 chars + "=" appended => 32 raw bytes.
  const padded = `${encodingAesKey}=`;
  return Buffer.from(padded, 'base64');
}

/**
 * Decrypt the encrypt field. Format (WeCom):
 *   [16 random bytes][4 bytes msg_len BE][msg][corp_id]
 */
export function decryptWecomPayload(args: {
  encrypt: string;
  config: WecomVerificationConfig;
}): { message: WecomMessageEvent; receivedCorpId: string } {
  const aesKey = deriveWecomAesKey(args.config.encodingAesKey);
  const buf = Buffer.from(args.encrypt, 'base64');
  if (buf.length < 32) throw new Error('wecom encrypt payload too short');
  const iv = buf.subarray(0, 16);
  const ct = buf.subarray(16);
  const d = createDecipheriv('aes-256-cbc', aesKey, iv);
  const dec = Buffer.concat([d.update(ct), d.final()]);
  // PKCS7 unpadding
  const pad = dec[dec.length - 1] ?? 0;
  const unpadded = dec.subarray(0, dec.length - pad);
  if (unpadded.length < 20) throw new Error('decrypted payload too short');
  const msgLen = unpadded.readUInt32BE(16);
  if (16 + 4 + msgLen > unpadded.length) throw new Error('msg_len exceeds buffer');
  const messageBytes = unpadded.subarray(20, 20 + msgLen);
  const corpBytes = unpadded.subarray(20 + msgLen);
  const message = JSON.parse(messageBytes.toString('utf8')) as WecomMessageEvent;
  return { message, receivedCorpId: corpBytes.toString('utf8') };
}

export interface IntakeEventFromWecom {
  sourceType: 'wecom';
  externalId: string;
  sender: { userId: string; displayName: string };
  chatId: string;
  chatType: 'p2p' | 'group';
  text: string;
  mentions: Array<{ id: string; name: string }>;
  receivedAt: string;
}

export function normalizeWecomEvent(
  msg: WecomMessageEvent,
  now: Date = new Date(),
): IntakeEventFromWecom | null {
  if (!msg.MsgId || !msg.FromUserName) return null;
  return {
    sourceType: 'wecom',
    externalId: `${msg.ChatId ?? ''}:${msg.MsgId}`,
    sender: { userId: msg.FromUserName, displayName: '' },
    chatId: msg.ChatId ?? '',
    chatType: (msg.ChatType ?? 'single') === 'group' ? 'group' : 'p2p',
    text: msg.Content ?? '',
    mentions: [], // WeCom doesn't have a structured mentions field; classifier
    // falls back to regex-matching @cgao in the message body.
    receivedAt: now.toISOString(),
  };
}

export type WecomSendFn = (args: { chatId: string; text: string }) => Promise<void>;

export class WecomAdapter {
  constructor(
    private readonly config: WecomVerificationConfig,
    private readonly send?: WecomSendFn,
  ) {}

  verifySignature(args: {
    timestamp: string;
    nonce: string;
    encrypt: string;
    signature: string;
  }): boolean {
    return verifyWecomSignature({
      token: this.config.token,
      timestamp: args.timestamp,
      nonce: args.nonce,
      encrypt: args.encrypt,
      signature: args.signature,
    });
  }

  async sendMessage(args: { chatId: string; text: string }): Promise<void> {
    if (!this.send) throw new Error('wecom send fn not configured');
    return this.send(args);
  }
}

function constantTimeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch {
    return false;
  }
}

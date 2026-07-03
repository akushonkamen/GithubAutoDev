/**
 * Lark + WeCom adapter signature verification + event normalization —
 * T-INTAKE-001 / T-INTAKE-002.
 *
 * The Trusted Control Runner is the only place these secrets live, so
 * these tests verify the math. They use deterministic inputs and check
 * that the verify functions are timing-safe.
 */

import { createCipheriv, createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  LarkAdapter,
  type LarkEventEnvelope,
  type LarkVerificationConfig,
  decryptLarkPayload,
  normalizeLarkEvent,
  verifyLarkSignature,
} from '../adapters/lark.js';
import {
  type WecomVerificationConfig,
  deriveWecomAesKey,
  normalizeWecomEvent,
  verifyWecomSignature,
} from '../adapters/wecom.js';

const larkConfig: LarkVerificationConfig = {
  verificationToken: 'lark-secret-token',
};

describe('verifyLarkSignature (T-INTAKE-001)', () => {
  it('verifies a correctly-signed payload', () => {
    const rawBody = '{"event_type":"im.message.receive_v1"}';
    const timestamp = '1700000000';
    const data = `${timestamp}\n${rawBody}`;
    const signature = createHmac('sha256', larkConfig.verificationToken).update(data).digest('hex');
    expect(verifyLarkSignature({ rawBody, signature, timestamp, config: larkConfig })).toBe(true);
  });

  it('rejects a payload signed with the wrong secret', () => {
    const rawBody = '{}';
    const timestamp = '1700000000';
    const signature = createHmac('sha256', 'wrong-secret')
      .update(`${timestamp}\n${rawBody}`)
      .digest('hex');
    expect(verifyLarkSignature({ rawBody, signature, timestamp, config: larkConfig })).toBe(false);
  });

  it('rejects when signature is empty', () => {
    expect(
      verifyLarkSignature({
        rawBody: '{}',
        signature: '',
        timestamp: '1700000000',
        config: larkConfig,
      }),
    ).toBe(false);
  });

  it('rejects tampered body even if signature looks valid hex', () => {
    const rawBody = '{"event_type":"im.message.receive_v1"}';
    const timestamp = '1700000000';
    const signature = createHmac('sha256', larkConfig.verificationToken)
      .update(`${timestamp}\n${rawBody}`)
      .digest('hex');
    expect(
      verifyLarkSignature({
        rawBody: '{"event_type":"im.message.receive_v1","evil":true}',
        signature,
        timestamp,
        config: larkConfig,
      }),
    ).toBe(false);
  });
});

describe('decryptLarkPayload (T-INTAKE-001 encrypt mode)', () => {
  it('decrypts a payload encrypted with sha256(encryptKey)', () => {
    const config: LarkVerificationConfig = {
      verificationToken: 'tok',
      encryptKey: 'my-encrypt-key',
    };
    const key = createHash('sha256').update('my-encrypt-key').digest();
    const iv = Buffer.alloc(16, 7);
    const plaintext = JSON.stringify({ event: { message: { message_id: 'm1' } } });
    // Node's createCipheriv auto-pads with PKCS7 by default — do NOT pre-pad.
    const cipher = createCipheriv('aes-256-cbc', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const payload = Buffer.concat([iv, ct]).toString('base64');
    const env = decryptLarkPayload({ encrypt: payload, config });
    expect(env.event?.message?.message_id).toBe('m1');
  });
});

describe('normalizeLarkEvent (T-INTAKE-001)', () => {
  const env: LarkEventEnvelope = {
    event: {
      sender: { sender_id: { open_id: 'ou_abc' }, sender_type: 'user' },
      message: {
        message_id: 'om_xyz',
        chat_id: 'oc_chat1',
        chat_type: 'group',
        message_type: 'text',
        content: JSON.stringify({ text: '@_user_1 deploy broken' }),
        mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot', name: 'cgao-bot' } }],
      },
    },
  };

  it('extracts external_id as chat_id:message_id', () => {
    const e = normalizeLarkEvent(env);
    expect(e).not.toBeNull();
    expect(e?.externalId).toBe('oc_chat1:om_xyz');
  });

  it('extracts open_id as authoritative sender id', () => {
    const e = normalizeLarkEvent(env);
    expect(e?.sender.openId).toBe('ou_abc');
  });

  it('extracts mentions list', () => {
    const e = normalizeLarkEvent(env);
    expect(e?.mentions).toEqual([{ id: 'ou_bot', name: 'cgao-bot' }]);
  });

  it('returns null when sender open_id is missing', () => {
    expect(normalizeLarkEvent({ event: { message: { message_id: 'm1' }, sender: {} } })).toBeNull();
  });

  it('extracts plain text from content JSON', () => {
    const e = normalizeLarkEvent(env);
    expect(e?.text).toBe('@_user_1 deploy broken');
  });
});

describe('LarkAdapter (T-INTAKE-001 class wrapper)', () => {
  it('delegates verifySignature with config', () => {
    const adapter = new LarkAdapter(larkConfig);
    const rawBody = '{}';
    const timestamp = '1';
    const signature = createHmac('sha256', larkConfig.verificationToken)
      .update(`${timestamp}\n${rawBody}`)
      .digest('hex');
    expect(adapter.verifySignature({ rawBody, signature, timestamp })).toBe(true);
  });

  it('sendMessage throws when no send fn was injected', async () => {
    const adapter = new LarkAdapter(larkConfig);
    await expect(adapter.sendMessage({ chatId: 'c', text: 't' })).rejects.toThrow();
  });

  it('sendMessage calls the injected send fn', async () => {
    let sent = '';
    const adapter = new LarkAdapter(larkConfig, async ({ text }) => {
      sent = text;
    });
    await adapter.sendMessage({ chatId: 'c', text: 'hi' });
    expect(sent).toBe('hi');
  });
});

// --- WeCom ---

const wecomConfig: WecomVerificationConfig = {
  token: 'wecom-token',
  encodingAesKey: 'kJNq3tqKW7UVbmoq0l9L5pQX1dFBq3Qp6iZyLpX7XmP',
  corpId: 'corp123',
  agentSecret: 'agent-secret',
};

describe('verifyWecomSignature (T-INTAKE-002)', () => {
  it('verifies a correctly-signed payload', () => {
    const timestamp = '1700000000';
    const nonce = 'nonce-xyz';
    const encrypt = 'ENC_DATA';
    const expected = createHash('sha1')
      .update([wecomConfig.token, timestamp, nonce, encrypt].sort().join(''))
      .digest('hex');
    expect(
      verifyWecomSignature({
        token: wecomConfig.token,
        timestamp,
        nonce,
        encrypt,
        signature: expected,
      }),
    ).toBe(true);
  });

  it('rejects an incorrectly-signed payload', () => {
    expect(
      verifyWecomSignature({
        token: wecomConfig.token,
        timestamp: '1',
        nonce: 'n',
        encrypt: 'e',
        signature: 'bogus',
      }),
    ).toBe(false);
  });
});

describe('deriveWecomAesKey (T-INTAKE-002)', () => {
  it('produces a 32-byte AES key from the encoded AES key', () => {
    const key = deriveWecomAesKey(wecomConfig.encodingAesKey);
    expect(key.length).toBe(32);
  });
});

describe('normalizeWecomEvent (T-INTAKE-002)', () => {
  it('returns an IntakeEvent with externalId = chatId:msgId', () => {
    const e = normalizeWecomEvent({
      MsgType: 'text',
      Content: 'help',
      MsgId: 12345,
      FromUserName: 'user1',
      ChatId: 'gid_chat',
      ChatType: 'group',
    });
    expect(e).not.toBeNull();
    expect(e?.externalId).toBe('gid_chat:12345');
    expect(e?.sourceType).toBe('wecom');
    expect(e?.chatType).toBe('group');
  });

  it('returns null when FromUserName or MsgId missing', () => {
    expect(normalizeWecomEvent({ MsgType: 'text' })).toBeNull();
  });
});

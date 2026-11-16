import { getCiphers } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  FrameDecryptor,
  FrameEncryptor,
  createTransportCrypto,
  deriveSessionKeys,
  generateEphemeralKeyPair,
  sha256Hex,
} from '../src/p2p/secure-channel.js';

const TRANSCRIPT = {
  initiatorPeerId: 'aa'.repeat(20),
  responderPeerId: 'bb'.repeat(20),
  initiatorNonce: '11'.repeat(16),
  responderNonce: '22'.repeat(16),
  initiatorPubHex: '',
  responderPubHex: '',
};

function makeSessionPair() {
  const initiator = generateEphemeralKeyPair();
  const responder = generateEphemeralKeyPair();
  const transcript = {
    ...TRANSCRIPT,
    initiatorPubHex: initiator.publicKeyHex,
    responderPubHex: responder.publicKeyHex,
  };
  const initiatorKeys = deriveSessionKeys(initiator.privateKey, responder.publicKeyHex, transcript, true);
  const responderKeys = deriveSessionKeys(responder.privateKey, initiator.publicKeyHex, transcript, false);
  return { initiatorKeys, responderKeys };
}

describe('secure channel', () => {
  it('generates 32-byte hex public keys', () => {
    const pair = generateEphemeralKeyPair();
    expect(pair.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('derives mirrored session keys on both sides', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    expect(initiatorKeys.sendKey.equals(responderKeys.recvKey)).toBe(true);
    expect(initiatorKeys.recvKey.equals(responderKeys.sendKey)).toBe(true);
    expect(initiatorKeys.sendKey.equals(initiatorKeys.recvKey)).toBe(false);
  });

  it('gives both ends the same channel binding, distinct per session', () => {
    const first = makeSessionPair();
    const second = makeSessionPair();
    expect(first.initiatorKeys.channelBinding.equals(first.responderKeys.channelBinding)).toBe(true);
    expect(first.initiatorKeys.channelBinding).toHaveLength(32);
    expect(first.initiatorKeys.channelBinding.equals(second.initiatorKeys.channelBinding)).toBe(false);
  });

  it('round-trips frames initiator -> responder and back', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    const a = createTransportCrypto(initiatorKeys);
    const b = createTransportCrypto(responderKeys);

    const m1 = new TextEncoder().encode('hello over encrypted tcp');
    const m2 = new TextEncoder().encode('second frame');
    const received = [
      ...b.decryptor.push(a.encryptor.encrypt(m1)),
      ...b.decryptor.push(a.encryptor.encrypt(m2)),
    ];
    expect(received.map((m) => new TextDecoder().decode(m))).toEqual([
      'hello over encrypted tcp',
      'second frame',
    ]);

    const reply = new TextEncoder().encode('reply');
    const back = a.decryptor.push(b.encryptor.encrypt(reply));
    expect(new TextDecoder().decode(back[0])).toBe('reply');
  });

  it('reassembles frames from arbitrary chunk boundaries', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    const a = new FrameEncryptor(initiatorKeys.sendKey);
    const b = new FrameDecryptor(responderKeys.recvKey);

    const payload = new Uint8Array(10_000).fill(7);
    const frame = Buffer.concat([a.encrypt(payload), a.encrypt(new TextEncoder().encode('tail'))]);

    const out: Uint8Array[] = [];
    for (let i = 0; i < frame.length; i += 977) {
      out.push(...b.push(frame.subarray(i, Math.min(i + 977, frame.length))));
    }
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveLength(10_000);
    expect(new TextDecoder().decode(out[1])).toBe('tail');
  });

  it('reassembles frames fed one byte at a time and many frames in one chunk', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    const a = new FrameEncryptor(initiatorKeys.sendKey);
    const b = new FrameDecryptor(responderKeys.recvKey);

    const bytes = a.encrypt(new Uint8Array(300).fill(3));
    const out: Uint8Array[] = [];
    for (let i = 0; i < bytes.length; i++) out.push(...b.push(bytes.subarray(i, i + 1)));
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual(new Uint8Array(300).fill(3));

    const words = ['one', 'two', 'three', 'four'];
    const batch = Buffer.concat(words.map((w) => a.encrypt(new TextEncoder().encode(w))));
    // The last frame arrives split across two pushes.
    const first = b.push(batch.subarray(0, batch.length - 5));
    const second = b.push(batch.subarray(batch.length - 5));
    expect([...first, ...second].map((m) => new TextDecoder().decode(m))).toEqual(words);
    expect(second).toHaveLength(1);
  });

  it('rejects tampered ciphertext', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    const a = new FrameEncryptor(initiatorKeys.sendKey);
    const b = new FrameDecryptor(responderKeys.recvKey);

    const frame = a.encrypt(new TextEncoder().encode('sensitive'));
    frame[6] ^= 0x01; // flip a ciphertext bit
    expect(() => b.push(frame)).toThrow();
  });

  it('rejects frames decrypted with the wrong direction key', () => {
    const { initiatorKeys, responderKeys } = makeSessionPair();
    const a = new FrameEncryptor(initiatorKeys.sendKey);
    // Wrong key: the responder's send key, not its recv key.
    const b = new FrameDecryptor(responderKeys.sendKey);
    const frame = a.encrypt(new TextEncoder().encode('x'));
    expect(() => b.push(frame)).toThrow();
  });

  it('rejects absurd frame lengths without buffering', () => {
    const { responderKeys } = makeSessionPair();
    const b = new FrameDecryptor(responderKeys.recvKey);
    const bogus = Buffer.alloc(8);
    bogus.writeUInt32BE(0xffffffff, 0);
    expect(() => b.push(bogus)).toThrow(/frame length/i);
  });

  it('binds derived keys to the transcript', () => {
    const initiator = generateEphemeralKeyPair();
    const responder = generateEphemeralKeyPair();
    const transcript = {
      ...TRANSCRIPT,
      initiatorPubHex: initiator.publicKeyHex,
      responderPubHex: responder.publicKeyHex,
    };
    const keys = deriveSessionKeys(initiator.privateKey, responder.publicKeyHex, transcript, true);
    const tampered = deriveSessionKeys(
      initiator.privateKey,
      responder.publicKeyHex,
      { ...transcript, responderNonce: '33'.repeat(16) },
      true,
    );
    expect(keys.sendKey.equals(tampered.sendKey)).toBe(false);
  });

  it('hashes sdp strings deterministically', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('uses a cipher available in both OpenSSL and BoringSSL', () => {
    // The desktop app runs the node under Electron's BoringSSL, which does not
    // register chacha20-poly1305 via createCipheriv ("Unknown cipher").
    // aes-256-gcm is registered in both; regression guard for that break.
    expect(getCiphers()).toContain('aes-256-gcm');
  });
});

/**
 * Encrypted TCP transport (transport.tcp-enc.v1): wallet-signed ephemeral
 * X25519 handshake, HKDF-SHA256 with transcript-bound salt, one AES-256-GCM
 * key per direction, length-prefixed frames with implicit counter nonces
 * (safe: per-direction keys, TCP ordering).
 *
 * AES-256-GCM (not ChaCha20-Poly1305) because it is registered in both OpenSSL
 * and BoringSSL; the desktop app runs the node under Electron's BoringSSL,
 * which does not expose chacha20-poly1305 via createCipheriv ("Unknown
 * cipher").
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  type KeyObject,
} from "node:crypto";

const AEAD_ALGORITHM = "aes-256-gcm";
const AEAD_TAG_BYTES = 16;
const FRAME_HEADER_BYTES = 4;
export const MAX_FRAME_PLAINTEXT_BYTES = 16 * 1024 * 1024;
const HKDF_INFO = "antseed-tcp-enc-v1";
const X25519_RAW_KEY_BYTES = 32;
/** DER SPKI prefix for an X25519 public key (RFC 8410). */
const X25519_SPKI_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export interface EphemeralKeyPair {
  privateKey: KeyObject;
  /** Raw 32-byte public key, lowercase hex (64 chars). */
  publicKeyHex: string;
}

export const X25519_PUB_HEX_REGEX = /^[0-9a-f]{64}$/;

export function generateEphemeralKeyPair(): EphemeralKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync("x25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(spki.length - X25519_RAW_KEY_BYTES);
  return { privateKey, publicKeyHex: raw.toString("hex") };
}

function importPublicKey(publicKeyHex: string): KeyObject {
  if (!X25519_PUB_HEX_REGEX.test(publicKeyHex)) {
    throw new Error("Invalid X25519 public key");
  }
  const der = Buffer.concat([X25519_SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);
  return createPublicKey({ key: der, format: "der", type: "spki" });
}

export interface SessionKeys {
  sendKey: Buffer;
  recvKey: Buffer;
  /** Handshake transcript hash: identical on both ends of this session, different for any other session. */
  channelBinding: Buffer;
}

export interface HandshakeTranscript {
  initiatorPeerId: string;
  responderPeerId: string;
  initiatorNonce: string;
  responderNonce: string;
  initiatorPubHex: string;
  responderPubHex: string;
}

function transcriptHash(t: HandshakeTranscript): Buffer {
  return createHash("sha256")
    .update(
      `${t.initiatorPeerId}|${t.responderPeerId}|${t.initiatorNonce}|${t.responderNonce}|${t.initiatorPubHex}|${t.responderPubHex}`,
      "utf8",
    )
    .digest();
}

/** Derive per-direction AEAD keys; `isInitiator` mirrors send/recv halves. */
export function deriveSessionKeys(
  localPrivateKey: KeyObject,
  remotePublicKeyHex: string,
  transcript: HandshakeTranscript,
  isInitiator: boolean,
): SessionKeys {
  const shared = diffieHellman({
    privateKey: localPrivateKey,
    publicKey: importPublicKey(remotePublicKeyHex),
  });
  const channelBinding = transcriptHash(transcript);
  const okm = Buffer.from(
    hkdfSync("sha256", shared, channelBinding, HKDF_INFO, 64),
  );
  const initiatorToResponder = okm.subarray(0, 32);
  const responderToInitiator = okm.subarray(32, 64);
  return isInitiator
    ? { sendKey: initiatorToResponder, recvKey: responderToInitiator, channelBinding }
    : { sendKey: responderToInitiator, recvKey: initiatorToResponder, channelBinding };
}

function counterIv(counter: bigint): Buffer {
  const iv = Buffer.alloc(12);
  iv.writeBigUInt64BE(counter, 4);
  return iv;
}

/** Encrypts outbound messages into length-prefixed AEAD frames. */
export class FrameEncryptor {
  private _counter = 0n;

  constructor(private readonly key: Buffer) {}

  encrypt(plaintext: Uint8Array): Buffer {
    if (plaintext.length > MAX_FRAME_PLAINTEXT_BYTES) {
      throw new Error(`Frame plaintext exceeds ${MAX_FRAME_PLAINTEXT_BYTES} bytes`);
    }
    const cipher = createCipheriv(AEAD_ALGORITHM, this.key, counterIv(this._counter), {
      authTagLength: AEAD_TAG_BYTES,
    });
    this._counter += 1n;
    const body = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
    const header = Buffer.alloc(FRAME_HEADER_BYTES);
    header.writeUInt32BE(body.length, 0);
    return Buffer.concat([header, body]);
  }
}

/** Accumulates inbound bytes and decrypts complete AEAD frames. */
export class FrameDecryptor {
  private _counter = 0n;
  // Received bytes not yet decrypted. They are joined only once a whole header
  // or frame is in: joining on every chunk copies a large frame over and over.
  private _chunks: Buffer[] = [];
  private _buffered = 0;
  /** Body length of the frame being received, once its header is in. */
  private _bodyLength: number | null = null;

  constructor(private readonly key: Buffer) {}

  /** Feed raw bytes, get decrypted messages. Throws are fatal for the connection. */
  push(chunk: Uint8Array): Uint8Array[] {
    this._chunks.push(Buffer.from(chunk));
    this._buffered += chunk.length;

    const messages: Uint8Array[] = [];
    while (this._buffered >= FRAME_HEADER_BYTES + (this._bodyLength ?? 0)) {
      const buffer = this._chunks.length === 1 ? this._chunks[0]! : Buffer.concat(this._chunks, this._buffered);
      this._chunks = [buffer];
      if (this._bodyLength === null) {
        const bodyLength = buffer.readUInt32BE(0);
        if (bodyLength < AEAD_TAG_BYTES || bodyLength > MAX_FRAME_PLAINTEXT_BYTES + AEAD_TAG_BYTES) {
          throw new Error(`Invalid encrypted frame length ${bodyLength}`);
        }
        this._bodyLength = bodyLength;
        continue;
      }
      const end = FRAME_HEADER_BYTES + this._bodyLength;
      const body = buffer.subarray(FRAME_HEADER_BYTES, end);
      const rest = buffer.subarray(end);
      this._chunks = rest.length > 0 ? [rest] : [];
      this._buffered = rest.length;
      this._bodyLength = null;

      const decipher = createDecipheriv(AEAD_ALGORITHM, this.key, counterIv(this._counter), {
        authTagLength: AEAD_TAG_BYTES,
      });
      this._counter += 1n;
      decipher.setAuthTag(body.subarray(body.length - AEAD_TAG_BYTES));
      const plaintext = Buffer.concat([
        decipher.update(body.subarray(0, body.length - AEAD_TAG_BYTES)),
        decipher.final(),
      ]);
      messages.push(new Uint8Array(plaintext));
    }
    // A leftover view would keep the whole joined buffer alive until the next frame completes.
    if (messages.length > 0 && this._chunks.length === 1) this._chunks = [Buffer.from(this._chunks[0]!)];
    return messages;
  }
}

/** Bidirectional cipher state attached to an encrypted TCP connection. */
export interface TransportCrypto {
  encryptor: FrameEncryptor;
  decryptor: FrameDecryptor;
  channelBinding: Buffer;
}

export function createTransportCrypto(keys: SessionKeys): TransportCrypto {
  return {
    encryptor: new FrameEncryptor(keys.sendKey),
    decryptor: new FrameDecryptor(keys.recvKey),
    channelBinding: keys.channelBinding,
  };
}

export function sha256Hex(data: string): string {
  return createHash("sha256").update(data, "utf8").digest("hex");
}

/**
 * Upstream end-to-end encryption (zero data access, Tier A).
 *
 * The buyer encrypts every chat message to a key that an upstream TEE attested, and the seller
 * forwards the request with its own upstream credential. The seller relays ciphertext only; the
 * upstream TEE decrypts, runs the model and encrypts each response chunk back to the buyer's
 * per-request key. `usage` stays in plaintext, so metering and billing are unchanged.
 *
 * Scheme `venice-v1` (Venice `e2ee-*` models):
 *   key   = HKDF-SHA256(ikm = ECDH_secp256k1(eph, peer).x, salt = none, info = "ecdsa_encryption", 32 bytes)
 *   wire  = hex(ephemeralPublicKey(65, uncompressed) ‖ iv(12) ‖ AES-256-GCM(ciphertext ‖ tag))
 *
 * Environment-free: secp256k1 from ethers, HKDF from @noble/hashes, AES-GCM from WebCrypto.
 */
import { SigningKey, computeAddress, getBytes, hexlify } from 'ethers';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

export const E2EE_SCHEMES = ['venice-v1'] as const;
export type E2eeScheme = (typeof E2EE_SCHEMES)[number];

export function isE2eeScheme(value: unknown): value is E2eeScheme {
  return typeof value === 'string' && (E2EE_SCHEMES as readonly string[]).includes(value);
}

/** Request headers of scheme `venice-v1` (lower-case, as they travel). */
export const VENICE_E2EE_HEADERS = {
  clientPublicKey: 'x-venice-tee-client-pub-key',
  modelPublicKey: 'x-venice-tee-model-pub-key',
  signingAlgo: 'x-venice-tee-signing-algo',
} as const;

/**
 * Seller route that relays the upstream attestation for one service. The buyer sends
 * `GET <path>?service=<service>&nonce=<64 hex>`; the seller fetches the upstream attestation for
 * the service's upstream model with its own credential and returns the JSON unchanged.
 */
export const E2EE_ATTESTATION_PATH = '/_antseed/e2ee/attestation';

const HKDF_INFO = new TextEncoder().encode('ecdsa_encryption');
const PUBLIC_KEY_BYTES = 65;
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Shortest ciphertext, as hex: an empty plaintext still carries key, iv and tag. */
const MIN_CIPHERTEXT_HEX = (PUBLIC_KEY_BYTES + IV_BYTES + TAG_BYTES) * 2;
const HEX_RE = /^[0-9a-fA-F]+$/;

export class E2eeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'E2eeError';
  }
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new E2eeError('WebCrypto is not available in this environment.');
  return value;
}

/** A copy backed by a plain ArrayBuffer, as WebCrypto's types require. */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return new Uint8Array(bytes);
}

function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return hexlify(bytes).slice(2);
}

/** An uncompressed secp256k1 public key (65 bytes, 0x04 prefix) from hex with or without 0x/04. */
export function normalizeE2eePublicKey(hex: string): Uint8Array {
  let clean = hex.trim().replace(/^0x/i, '');
  if (clean.length === 128) clean = `04${clean}`;
  if (clean.length !== PUBLIC_KEY_BYTES * 2 || !HEX_RE.test(clean) || !clean.startsWith('04')) {
    throw new E2eeError('Not an uncompressed secp256k1 public key.');
  }
  return getBytes(`0x${clean}`);
}

async function aesKey(privateKey: SigningKey, peerPublicKey: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const shared = getBytes(privateKey.computeSharedSecret(peerPublicKey)); // 0x04 ‖ X ‖ Y
  const key = hkdf(sha256, shared.slice(1, 33), undefined, HKDF_INFO, 32);
  try {
    return await subtle().importKey('raw', owned(key), { name: 'AES-GCM' }, false, [usage]);
  } finally {
    key.fill(0);
    shared.fill(0);
  }
}

/** Whether a string has the shape of a `venice-v1` ciphertext. */
export function isE2eeCiphertext(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= MIN_CIPHERTEXT_HEX
    && value.length % 2 === 0
    && HEX_RE.test(value);
}

/** Encrypts one message to the attested model key with a fresh ephemeral key. */
export async function encryptE2eeText(plaintext: string, modelPublicKey: string): Promise<string> {
  const peer = normalizeE2eePublicKey(modelPublicKey);
  const ephemeral = new SigningKey(randomBytes(32));
  const key = await aesKey(ephemeral, peer, 'encrypt');
  const iv = randomBytes(IV_BYTES);
  const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)));
  const out = new Uint8Array(PUBLIC_KEY_BYTES + IV_BYTES + sealed.length);
  out.set(getBytes(ephemeral.publicKey), 0);
  out.set(iv, PUBLIC_KEY_BYTES);
  out.set(sealed, PUBLIC_KEY_BYTES + IV_BYTES);
  return toHex(out);
}

/** Decrypts one response chunk sealed to the buyer's per-request key. */
export async function decryptE2eeText(ciphertext: string, clientKey: SigningKey): Promise<string> {
  if (!isE2eeCiphertext(ciphertext)) throw new E2eeError('Not an E2EE ciphertext.');
  const raw = getBytes(`0x${ciphertext}`);
  const key = await aesKey(clientKey, raw.slice(0, PUBLIC_KEY_BYTES), 'decrypt');
  try {
    const plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: owned(raw.slice(PUBLIC_KEY_BYTES, PUBLIC_KEY_BYTES + IV_BYTES)) },
      key,
      owned(raw.slice(PUBLIC_KEY_BYTES + IV_BYTES)),
    );
    return new TextDecoder().decode(plain);
  } catch {
    throw new E2eeError('Could not decrypt a response chunk.');
  }
}

/** One request's keys: the attested model key and a fresh client key the response is sealed to. */
export interface E2eeSession {
  scheme: E2eeScheme;
  modelPublicKey: string;
  clientKey: SigningKey;
}

export function createE2eeSession(modelPublicKey: string, scheme: E2eeScheme = 'venice-v1'): E2eeSession {
  const normalized = toHex(normalizeE2eePublicKey(modelPublicKey));
  return { scheme, modelPublicKey: normalized, clientKey: new SigningKey(randomBytes(32)) };
}

/** Headers that tell the upstream to decrypt the request and seal the response to the client key. */
export function e2eeRequestHeaders(session: E2eeSession): Record<string, string> {
  return {
    [VENICE_E2EE_HEADERS.clientPublicKey]: session.clientKey.publicKey.slice(2),
    [VENICE_E2EE_HEADERS.modelPublicKey]: session.modelPublicKey,
    [VENICE_E2EE_HEADERS.signingAlgo]: 'ecdsa',
  };
}

/** Whether a header name belongs to an E2EE scheme (the seller must forward these untouched). */
export function isE2eeHeader(name: string): boolean {
  return name.toLowerCase().startsWith('x-venice-tee-');
}

/** Request fields whose content an E2EE upstream cannot protect, so an E2EE request refuses them. */
const UNPROTECTED_FIELDS = ['tools', 'functions', 'tool_choice', 'function_call', 'audio', 'prediction'] as const;

/** The roles whose messages are text an E2EE upstream decrypts. */
const TEXT_ROLES = new Set(['system', 'developer', 'user', 'assistant']);

/** Whether a message field holds nothing: absent, null, or an empty string, list or object. */
function isEmptyField(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'object' && Object.keys(value).length === 0;
}

function messageText(content: unknown, index: number): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content.map((part) => {
      const item = part as { type?: unknown; text?: unknown };
      if (item && item.type === 'text' && typeof item.text === 'string') return item.text;
      throw new E2eeError(`Message ${index} has a non-text part; end-to-end encryption carries text only.`);
    });
    return parts.join('\n');
  }
  throw new E2eeError(`Message ${index} has no text content.`);
}

/**
 * Encrypts every message of an OpenAI Chat Completions request (system, user, assistant and
 * history alike) and sends each as its role and that ciphertext only. Fails closed: a request
 * it cannot fully protect (images, audio, tool calls or tool definitions, a message with
 * reasoning or any other field that holds a value) throws instead of sending anything in plaintext.
 */
export async function encryptChatCompletionRequest(
  body: Record<string, unknown>,
  session: E2eeSession,
): Promise<Record<string, unknown>> {
  for (const field of UNPROTECTED_FIELDS) {
    if (body[field] !== undefined && body[field] !== null) {
      throw new E2eeError(`End-to-end encryption does not cover \`${field}\`; remove it or turn off zero data access.`);
    }
  }
  if (!Array.isArray(body['messages']) || body['messages'].length === 0) {
    throw new E2eeError('An end-to-end encrypted request needs a messages array.');
  }
  const messages = await Promise.all(body['messages'].map(async (raw, index) => {
    const message = raw as Record<string, unknown>;
    if (!message || typeof message !== 'object') throw new E2eeError(`Message ${index} is not an object.`);
    if (message['tool_calls'] !== undefined || message['function_call'] !== undefined || message['role'] === 'tool' || message['role'] === 'function') {
      throw new E2eeError(`Message ${index} is a tool call or result; end-to-end encryption carries text only.`);
    }
    const { role, content, name: _name, ...rest } = message;
    if (typeof role !== 'string' || !TEXT_ROLES.has(role)) throw new E2eeError(`Message ${index} has a role end-to-end encryption does not carry.`);
    // Only the role and the encrypted text are sent. Any other field with a value (reasoning, a refusal, annotations) would go in plaintext.
    const unprotected = Object.keys(rest).find((field) => !isEmptyField(rest[field]));
    if (unprotected !== undefined) {
      throw new E2eeError(`End-to-end encryption does not cover \`${unprotected}\` of message ${index}; remove it or turn off zero data access.`);
    }
    return { role, content: await encryptE2eeText(messageText(content, index), session.modelPublicKey) };
  }));
  return { ...body, messages };
}

const ENCRYPTED_FIELDS = ['content', 'reasoning_content', 'reasoning'] as const;

async function decryptFields(target: Record<string, unknown> | undefined, session: E2eeSession, stats: E2eeResponseStats): Promise<void> {
  if (!target || typeof target !== 'object') return;
  for (const field of ENCRYPTED_FIELDS) {
    const value = target[field];
    if (typeof value !== 'string' || value.length === 0) continue;
    if (isE2eeCiphertext(value)) {
      target[field] = await decryptE2eeText(value, session.clientKey);
      stats.encrypted += 1;
    } else {
      stats.plaintext += 1;
    }
  }
}

export interface E2eeResponseStats {
  /** Response fields that arrived encrypted and were decrypted. */
  encrypted: number;
  /** Non-empty response fields that arrived in plaintext. */
  plaintext: number;
}

/** Decrypts a non-streamed Chat Completions response in place and returns it. */
export async function decryptChatCompletionResponse(
  body: Record<string, unknown>,
  session: E2eeSession,
  stats: E2eeResponseStats = { encrypted: 0, plaintext: 0 },
): Promise<Record<string, unknown>> {
  const choices = Array.isArray(body['choices']) ? body['choices'] : [];
  for (const choice of choices) {
    await decryptFields((choice as Record<string, unknown>)?.['message'] as Record<string, unknown> | undefined, session, stats);
  }
  return body;
}

/**
 * Decrypts a Chat Completions SSE stream chunk by chunk. Feed it the raw text as it arrives;
 * it returns the text to pass on, holding back only an unfinished line. Lines that are not
 * JSON `data:` events pass through unchanged.
 */
export class E2eeSseDecryptor {
  readonly stats: E2eeResponseStats = { encrypted: 0, plaintext: 0 };
  private pending = '';

  constructor(private readonly session: E2eeSession) {}

  async push(text: string): Promise<string> {
    this.pending += text;
    const end = this.pending.lastIndexOf('\n');
    if (end < 0) return '';
    const complete = this.pending.slice(0, end + 1);
    this.pending = this.pending.slice(end + 1);
    return this.transform(complete);
  }

  async flush(): Promise<string> {
    const rest = this.pending;
    this.pending = '';
    return rest ? this.transform(rest) : '';
  }

  private async transform(text: string): Promise<string> {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const match = /^data:\s?(.*?)(\r?)$/.exec(line);
      if (!match || !match[1] || match[1] === '[DONE]') continue;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(match[1]) as Record<string, unknown>;
      } catch {
        continue;
      }
      const choices = Array.isArray(event['choices']) ? event['choices'] : [];
      let changed = false;
      for (const choice of choices) {
        const delta = (choice as Record<string, unknown>)?.['delta'] as Record<string, unknown> | undefined;
        const before = this.stats.encrypted;
        await decryptFields(delta, this.session, this.stats);
        if (this.stats.encrypted !== before) changed = true;
      }
      if (changed) lines[i] = `data: ${JSON.stringify(event)}${match[2]}`;
    }
    return lines.join('\n');
  }
}

// ---------------------------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------------------------

/** The fields of an upstream attestation the buyer checks. Extra fields are ignored. */
export interface UpstreamE2eeAttestation {
  nonce?: unknown;
  signing_key?: unknown;
  signing_public_key?: unknown;
  signing_address?: unknown;
  intel_quote?: unknown;
  [key: string]: unknown;
}

/** DCAP verification of a TDX quote, injected by the host (the CLI uses the antseed-verifier's). */
export type E2eeQuoteVerifier = (quote: Uint8Array) => Promise<{
  /** DCAP TCB status, e.g. `UpToDate`. */
  status: string;
  /** Whether the TCB status is acceptable to this buyer. */
  acceptable: boolean;
  /** The quote's 64-byte report_data; null when it is not a TDX quote. */
  reportData: Uint8Array | null;
  /** TD debug attribute; a debug TD is never accepted. */
  debug: boolean | null;
}>;

export interface VerifiedE2eeAttestation {
  modelPublicKey: string;
  signingAddress: string;
  tcbStatus: string;
}

/** A 32-byte buyer nonce as 64 lower-case hex characters. */
export function createE2eeNonce(): string {
  return toHex(randomBytes(32));
}

export function decodeQuote(value: string): Uint8Array {
  const clean = value.trim();
  if (HEX_RE.test(clean) && clean.length % 2 === 0) return getBytes(`0x${clean}`);
  const binary = atob(clean);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Verifies an upstream attestation locally and returns the model key to encrypt to. It never
 * trusts the upstream's own `verified` field. Checks:
 *  - the attestation echoes the buyer's nonce;
 *  - the TDX quote passes DCAP with an acceptable TCB and is not a debug TD;
 *  - report_data = signing_address(20) ‖ zero(12) ‖ nonce(32), so the quote is fresh and names the key;
 *  - the public key hashes to that signing address.
 */
export async function verifyUpstreamE2eeAttestation(
  attestation: UpstreamE2eeAttestation,
  nonce: string,
  verifyQuote: E2eeQuoteVerifier,
): Promise<VerifiedE2eeAttestation> {
  const expectedNonce = nonce.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expectedNonce)) throw new E2eeError('The attestation nonce must be 32 bytes of hex.');
  if (typeof attestation.nonce !== 'string' || attestation.nonce.toLowerCase() !== expectedNonce) {
    throw new E2eeError('The attestation does not echo our nonce.');
  }
  const key = typeof attestation.signing_key === 'string' ? attestation.signing_key
    : typeof attestation.signing_public_key === 'string' ? attestation.signing_public_key : '';
  if (!key) throw new E2eeError('The attestation has no model public key.');
  const publicKey = normalizeE2eePublicKey(key);
  const address = computeAddress(hexlify(publicKey)).toLowerCase();
  if (typeof attestation.signing_address === 'string' && attestation.signing_address.toLowerCase() !== address) {
    throw new E2eeError('The model public key does not match the attested signing address.');
  }
  if (typeof attestation.intel_quote !== 'string' || attestation.intel_quote.length === 0) {
    throw new E2eeError('The attestation has no TDX quote.');
  }
  let quote: Uint8Array;
  try {
    quote = decodeQuote(attestation.intel_quote);
  } catch {
    throw new E2eeError('The attestation quote is not valid hex or base64.');
  }
  const verdict = await verifyQuote(quote);
  if (!verdict.acceptable) throw new E2eeError(`The upstream TDX quote failed DCAP (TCB status ${verdict.status}).`);
  if (verdict.debug !== false) throw new E2eeError('The upstream TDX quote is from a debug TD or its debug state is unknown.');
  if (!verdict.reportData || verdict.reportData.length !== 64) throw new E2eeError('The upstream quote is not a TDX quote.');
  const expected = new Uint8Array(64);
  expected.set(getBytes(address), 0);
  expected.set(getBytes(`0x${expectedNonce}`), 32);
  if (!equalBytes(verdict.reportData, expected)) {
    throw new E2eeError('The upstream quote does not bind the model key and our nonce.');
  }
  return { modelPublicKey: toHex(publicKey), signingAddress: address, tcbStatus: verdict.status };
}

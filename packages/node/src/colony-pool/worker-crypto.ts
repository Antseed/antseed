import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { getAddress, getBytes, keccak256, solidityPacked, verifyMessage } from 'ethers';
import type { DeviceAttestation } from './apple-attestation.js';
import { b64url, p256Jwk, publicKeyObject } from './p256.js';
import type { WorkerAttestation } from './worker-attestation.js';

/**
 * End-to-end encryption between a buyer and a colony pool's worker. The pool
 * routes ciphertext only. Spec: docs/protocol/colony-pool.md.
 */

export {
  WORKER_E2E_CAPABILITY,
  workerE2EProviderCapability,
  WORKER_ASSIGN_PATH,
  WORKER_UNAVAILABLE_STATUS,
  WORKER_UNAVAILABLE_CODE,
} from '@antseed/buyer-core/worker-e2e';
import { isWorkerPayment, type WorkerPayment } from './worker-payment.js';
export {
  modelFilesDigest,
  workerAttestationMessage,
  isWorkerAttestation,
  verifyWorkerAttestation,
} from './worker-attestation.js';
export type {
  WorkerAttestation,
  AttestedModel,
  AttestationPolicy,
} from './worker-attestation.js';
export const WORKER_E2E_VERSION = 3;

const INFO = 'antseed-worker-e2e/v3';
/** Most workers one request is encrypted for (the pool fails over within them). */
export const MAX_WORKER_RECIPIENTS = 3;
/** A worker's key certificate stops taking new buyers this long before it expires (buyers reassign, pools stop routing). */
export const WORKER_CERTIFICATE_USABILITY_MARGIN_S = 300;
const TAG_BYTES = 16;
/**
 * AES-256-GCM, not ChaCha20-Poly1305: the desktop app runs the buyer under
 * Electron's BoringSSL, which has no `chacha20-poly1305` in `createCipheriv`.
 */
const AEAD = 'aes-256-gcm';
const P256_PUBLIC_HEX = /^04[0-9a-f]{128}$/;
const ZERO_CHANNEL = `0x${'00'.repeat(32)}`;

// ── keys ──

/**
 * P-256, so a Mac can keep its key in the Secure Enclave (which has no
 * X25519). Public keys travel as uncompressed SEC1 points (65 bytes).
 */
export interface WorkerEncryptionKey {
  /** Uncompressed P-256 public key (0x04 ‖ x ‖ y). */
  publicKey: Uint8Array;
  /** 32-byte P-256 private scalar. */
  privateKey: Uint8Array;
}

export function generateWorkerEncryptionKey(): WorkerEncryptionKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { x, y, d } = privateKey.export({ format: 'jwk' });
  if (!x || !y || !d) throw new Error('P-256 key export did not contain x, y and d');
  return {
    publicKey: new Uint8Array(Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')])),
    privateKey: new Uint8Array(Buffer.from(d, 'base64url')),
  };
}

function privateKeyObject(key: WorkerEncryptionKey): KeyObject {
  if (key.privateKey.length !== 32) throw new Error('P-256 private key must be 32 bytes');
  return createPrivateKey({ key: { ...p256Jwk(key.publicKey), d: b64url(key.privateKey) }, format: 'jwk' });
}

function toHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

// ── key certificates ──

/** A worker's binding of its encryption key (and attestation key) to its address, for one pool. */
export interface WorkerKeyCertificate {
  worker: string;
  /** P-256 encryption public key, lowercase hex without 0x. */
  key: string;
  /** Unix seconds. */
  expires: number;
  /** EIP-191 signature by `worker` over workerKeyCertificateMessage. */
  certificate: string;
  /** Pool seller address. */
  pool: string;
  /** P-256 key that signs the worker's attestations (Secure Enclave on a Mac); absent for unattested workers. */
  attestationKey?: string;
}

export function workerKeyCertificateMessage(pool: string, keyHex: string, expires: number, attestationKeyHex = ''): string {
  return `antseed-worker-key/v2\npool:${pool.toLowerCase()}\nkey:${keyHex.toLowerCase()}\nexpires:${expires}\nattestation-key:${attestationKeyHex.toLowerCase()}`;
}

/** True when the certificate is signed by its worker, names `pool`, and has not expired. */
export function verifyWorkerKeyCertificate(cert: WorkerKeyCertificate, pool: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (cert.pool.toLowerCase() !== pool.toLowerCase() || cert.expires <= nowSeconds) return false;
  if (!P256_PUBLIC_HEX.test(cert.key)) return false;
  if (cert.attestationKey !== undefined && !P256_PUBLIC_HEX.test(cert.attestationKey)) return false;
  try {
    return verifyMessage(workerKeyCertificateMessage(cert.pool, cert.key, cert.expires, cert.attestationKey), cert.certificate).toLowerCase()
      === cert.worker.toLowerCase();
  } catch {
    return false;
  }
}

/** What a pool hands a buyer for one worker: its certificate, latest attestation, and Apple's, when the pool's MDM has one. */
export interface WorkerAssignment extends WorkerKeyCertificate {
  attestation?: WorkerAttestation;
  deviceAttestation?: DeviceAttestation;
}

// ── primitives ──

interface RecipientKeys {
  /** Wraps the request's content key for this recipient. */
  wrapKey: Buffer;
  /** This recipient's own response key: no other recipient can answer under it. */
  responseKey: Buffer;
}

function deriveKeys(shared: Buffer, ephemeralPublic: Uint8Array, workerPublic: Uint8Array): RecipientKeys {
  const okm = Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, workerPublic]), INFO, 64));
  return { wrapKey: okm.subarray(0, 32), responseKey: okm.subarray(32, 64) };
}

function nonceFor(seq: number): Buffer {
  const nonce = Buffer.alloc(12);
  nonce.writeBigUInt64BE(BigInt(seq), 4);
  return nonce;
}

function seal(key: Buffer, seq: number, aad: string, plaintext: Uint8Array): Buffer {
  const cipher = createCipheriv(AEAD, key, nonceFor(seq), { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  return Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}

function open(key: Buffer, seq: number, aad: string, sealed: Uint8Array): Buffer {
  if (sealed.length < TAG_BYTES) throw new Error('Ciphertext too short');
  const body = sealed.subarray(0, sealed.length - TAG_BYTES);
  const decipher = createDecipheriv(AEAD, key, nonceFor(seq), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** The ordered recipient list as the AADs bind it: lowercase addresses joined by commas. */
function recipientList(workers: readonly string[]): string {
  return workers.map((worker) => worker.toLowerCase()).join(',');
}

function requestAad(workers: readonly string[], model: string): string {
  return `${INFO}|req|${recipientList(workers)}|${model}`;
}

function wrapAad(workers: readonly string[], model: string): string {
  return `${INFO}|wrap|${recipientList(workers)}|${model}`;
}

/**
 * Each response is sealed under its own key, from the request's response key
 * and a random salt the worker picks, so a pool replaying a request never
 * gets two answers under the same key and nonce.
 */
const RESPONSE_SALT_BYTES = 16;

function responseKey(base: Buffer, salt: Buffer): Buffer {
  if (salt.length !== RESPONSE_SALT_BYTES) throw new Error('Response salt must be 16 bytes');
  return Buffer.from(hkdfSync('sha256', base, salt, `${INFO}|resp-key`, 32));
}

function responseAad(seq: number, end: boolean): string {
  return `${INFO}|resp|${seq}${end ? '|end' : ''}`;
}

/** How long a buyer's signed request stays valid; workers serve each one at most once within it. */
export const WORKER_REQUEST_TTL_SECONDS = 600;

/**
 * Hash the buyer signs to bind a request to its channel, its expiry and the
 * ordered set of workers it is encrypted for:
 * keccak256(INFO ‖ worker₁ ‖ … ‖ workerₙ ‖ channel ‖ uint64 exp ‖ keccak256(ct)).
 */
export function requestBindingHash(
  workers: string | readonly string[],
  channel: string,
  expires: number,
  ciphertext: Uint8Array,
): string {
  const list = typeof workers === 'string' ? [workers] : workers;
  return keccak256(solidityPacked(
    ['string', ...list.map(() => 'address'), 'bytes32', 'uint64', 'bytes32'],
    [INFO, ...list, channel, expires, keccak256(ciphertext)],
  ));
}

/**
 * The binding hash when `signature` over it is `buyer`'s, else null. Throws on
 * a malformed signature or field, which callers treat as no binding.
 */
export function verifiedRequestBindingHash(
  workers: readonly string[],
  channel: string,
  expires: number,
  ciphertext: Uint8Array,
  signature: string,
  buyer: string,
): string | null {
  const hash = requestBindingHash(workers, channel, expires, ciphertext);
  return verifyMessage(getBytes(hash), signature).toLowerCase() === buyer.toLowerCase() ? hash : null;
}

// ── envelopes ──

/** One worker a request is encrypted for: its ephemeral key and its wrapped copy of the content key. */
export interface RequestRecipient {
  worker: string;
  epk: string;
  /** The content key sealed under this recipient's wrap key (48 bytes, base64). */
  wk: string;
}

export interface RequestEnvelope {
  v: number;
  /** In the pool's rank order; the pool tries them one at a time. */
  recipients: RequestRecipient[];
  ct: string;
  buyer?: string;
  channel?: string;
  /** Unix seconds after which workers refuse the request. */
  exp?: number;
  sig?: string;
  /** The buyer's latest SpendingAuth on `channel`: pays for the worker's earlier answers there (signed on its own). */
  pay?: WorkerPayment;
}

/** The recipients the request envelope in a parsed JSON body names, in order (empty for anything else). */
export function parsedEnvelopeRecipients(parsed: unknown): string[] {
  const recipients = (parsed as { antseed_e2e?: { recipients?: unknown } } | null | undefined)?.antseed_e2e?.recipients;
  if (!Array.isArray(recipients)) return [];
  return recipients.map((r) => (r as { worker?: unknown })?.worker).filter((w): w is string => typeof w === 'string');
}

/** `parsedEnvelopeRecipients` of a body still to parse. */
export function envelopeRecipients(body: Uint8Array): string[] {
  try {
    return parsedEnvelopeRecipients(JSON.parse(Buffer.from(body).toString('utf-8')));
  } catch {
    return [];
  }
}

export interface UsageLike {
  [key: string]: unknown;
}

export interface BuyerBinding {
  address: string;
  channel?: string;
  /** Unix seconds; defaults to WORKER_REQUEST_TTL_SECONDS from now. */
  expires?: number;
  /** The buyer's latest SpendingAuth on `channel`, if it signed one. */
  payment?: WorkerPayment;
  signMessage(message: Uint8Array): string | Promise<string>;
}

export interface SealRecipient {
  worker: string;
  /** Worker P-256 public key (uncompressed bytes or hex). */
  key: Uint8Array | string;
}

export interface SealRequestOptions {
  /** The original JSON request body. */
  body: Uint8Array;
  /** One worker (shorthand for a single recipient)… */
  worker?: string;
  workerKey?: Uint8Array | string;
  /** …or up to MAX_WORKER_RECIPIENTS, in the order the pool should try them. */
  recipients?: SealRecipient[];
  /** Buyer identity that signs the request binding; omitted for pool health checks. */
  buyer?: BuyerBinding;
}

export interface SealedRequest {
  body: Uint8Array;
  model: string;
  opener: ResponseOpener;
}

function keyBytes(key: Uint8Array | string): Uint8Array {
  return typeof key === 'string' ? new Uint8Array(Buffer.from(key.replace(/^0x/, ''), 'hex')) : key;
}

/**
 * Buyer side: encrypt a JSON request body once, for one or more workers.
 * Each recipient unwraps the content key with its own ECDH secret and answers
 * under its own response key, so the buyer always knows which one answered.
 */
export async function sealRequest(opts: SealRequestOptions): Promise<SealedRequest> {
  const parsed = JSON.parse(Buffer.from(opts.body).toString('utf-8')) as Record<string, unknown>;
  const model = parsed['model'];
  if (typeof model !== 'string' || model.length === 0) throw new Error('Request body must name a model');
  const given = opts.recipients ?? (opts.worker && opts.workerKey ? [{ worker: opts.worker, key: opts.workerKey }] : []);
  if (given.length === 0 || given.length > MAX_WORKER_RECIPIENTS) {
    throw new Error(`A request is encrypted for 1 to ${MAX_WORKER_RECIPIENTS} workers`);
  }
  const workers = given.map((r) => getAddress(r.worker));
  if (new Set(workers.map((w) => w.toLowerCase())).size !== workers.length) throw new Error('Recipients must be distinct workers');

  const contentKey = randomBytes(32);
  const ct = seal(contentKey, 0, requestAad(workers, model), opts.body);
  const responseKeys = new Map<string, Buffer>();
  const recipients = given.map((recipient, i): RequestRecipient => {
    const workerKey = keyBytes(recipient.key);
    const ephemeral = generateWorkerEncryptionKey();
    const shared = diffieHellman({ privateKey: privateKeyObject(ephemeral), publicKey: publicKeyObject(workerKey) });
    const keys = deriveKeys(shared, ephemeral.publicKey, workerKey);
    responseKeys.set(workers[i]!.toLowerCase(), keys.responseKey);
    return {
      worker: workers[i]!,
      epk: Buffer.from(ephemeral.publicKey).toString('base64'),
      wk: seal(keys.wrapKey, 0, wrapAad(workers, model), contentKey).toString('base64'),
    };
  });

  const envelope: RequestEnvelope = { v: WORKER_E2E_VERSION, recipients, ct: ct.toString('base64') };
  if (opts.buyer) {
    const channel = opts.buyer.channel ?? ZERO_CHANNEL;
    const expires = opts.buyer.expires ?? Math.floor(Date.now() / 1000) + WORKER_REQUEST_TTL_SECONDS;
    envelope.buyer = getAddress(opts.buyer.address);
    envelope.channel = channel;
    envelope.exp = expires;
    envelope.sig = await opts.buyer.signMessage(getBytes(requestBindingHash(workers, channel, expires, ct)));
    if (opts.buyer.payment) envelope.pay = opts.buyer.payment;
  }
  const outer: Record<string, unknown> = { model };
  if (typeof parsed['stream'] === 'boolean') outer['stream'] = parsed['stream'];
  for (const key of ['max_tokens', 'max_completion_tokens']) {
    if (typeof parsed[key] === 'number') outer[key] = parsed[key];
  }
  outer['antseed_e2e'] = envelope;
  return {
    body: new TextEncoder().encode(JSON.stringify(outer)),
    model,
    opener: new ResponseOpener(responseKeys),
  };
}

export interface OpenedRequest {
  /** The original JSON request body. */
  body: Uint8Array;
  model: string;
  /** Every worker the request is encrypted for, in order. */
  recipients: string[];
  /** Set when the buyer signed the binding and the signature recovers to it. */
  buyer: string | null;
  channel: string | null;
  /** The signed expiry (unix seconds) and binding hash, set with `buyer`. */
  expires: number | null;
  binding: string | null;
  sealer: ResponseSealer;
}

/** True when a request body carries an encrypted envelope. */
export function isSealedRequest(body: Uint8Array): boolean {
  try {
    const parsed = JSON.parse(Buffer.from(body).toString('utf-8')) as Record<string, unknown>;
    return typeof parsed['antseed_e2e'] === 'object' && parsed['antseed_e2e'] !== null;
  } catch {
    return false;
  }
}

/** A buyer's signed binding of a request to its channel, expiry and workers. */
export interface RequestBinding {
  /** The buyer who signed it (checksummed). */
  buyer: string;
  channel: string;
  /** The signed expiry, unix seconds. */
  expires: number;
  hash: string;
}

/**
 * An encrypted request read from its clear fields and addressed to this
 * worker, its buyer binding verified, not yet decrypted: enough to admit or
 * refuse it without reading it.
 */
export interface InspectedRequest {
  model: string;
  /** Every worker the request is encrypted for, in order, as the envelope names them. */
  workers: string[];
  /** The worker it was inspected for. */
  worker: string;
  /** This worker's wrapped key. */
  recipient: { epk: string; wk: string };
  ciphertext: Buffer;
  /** Null without a valid buyer signature: an unbound (health check) request. */
  binding: RequestBinding | null;
  /** The buyer's latest SpendingAuth the request carries (well-formed, not yet verified), with a binding only. */
  payment: WorkerPayment | null;
}

/**
 * Worker side: check a request's envelope and its buyer binding before
 * decrypting it. Throws when it is not an encrypted request for this worker.
 */
export function inspectRequest(body: Uint8Array, workerAddress: string): InspectedRequest {
  const outer = JSON.parse(Buffer.from(body).toString('utf-8')) as Record<string, unknown>;
  const envelope = outer['antseed_e2e'] as RequestEnvelope | undefined;
  const model = outer['model'];
  if (!envelope || typeof model !== 'string') throw new Error('Not an encrypted request');
  if (envelope.v !== WORKER_E2E_VERSION) throw new Error(`Unsupported envelope version ${envelope.v}`);
  if (!Array.isArray(envelope.recipients) || envelope.recipients.length === 0 || envelope.recipients.length > MAX_WORKER_RECIPIENTS
    || typeof envelope.ct !== 'string') {
    throw new Error('Malformed envelope');
  }
  const workers = envelope.recipients.map((r) => {
    if (typeof r?.worker !== 'string' || typeof r.epk !== 'string' || typeof r.wk !== 'string') throw new Error('Malformed envelope');
    return r.worker;
  });
  if (new Set(workers.map((w) => w.toLowerCase())).size !== workers.length) throw new Error('Envelope names a worker twice');
  const mine = envelope.recipients.find((r) => r.worker.toLowerCase() === workerAddress.toLowerCase());
  if (!mine) throw new Error('Envelope is addressed to other workers');
  const ciphertext = Buffer.from(envelope.ct, 'base64');

  let binding: RequestBinding | null = null;
  // A channel is exactly 32 bytes: a longer one would name the same on-chain channel under another key.
  if (envelope.buyer && envelope.sig && typeof envelope.channel === 'string' && /^0x[0-9a-fA-F]{64}$/.test(envelope.channel)
    && Number.isSafeInteger(envelope.exp) && envelope.exp! >= 0) {
    try {
      const hash = verifiedRequestBindingHash(workers, envelope.channel, envelope.exp!, ciphertext, envelope.sig, envelope.buyer);
      if (hash) binding = { buyer: getAddress(envelope.buyer), channel: envelope.channel.toLowerCase(), expires: envelope.exp!, hash };
    } catch {
      // Unsigned or forged binding: treated as an unbound (health check) request.
    }
  }
  const payment = binding && isWorkerPayment(envelope.pay) ? envelope.pay : null;
  return { model, workers, worker: workerAddress, recipient: { epk: mine.epk, wk: mine.wk }, ciphertext, binding, payment };
}

/**
 * Worker side: decrypt an inspected request. Throws when the envelope fails
 * authentication or the inner model differs from the outer one.
 */
export function decryptRequest(request: InspectedRequest, workerKey: WorkerEncryptionKey): OpenedRequest {
  const { model, workers, binding } = request;
  const epk = new Uint8Array(Buffer.from(request.recipient.epk, 'base64'));
  const shared = diffieHellman({ privateKey: privateKeyObject(workerKey), publicKey: publicKeyObject(epk) });
  const keys = deriveKeys(shared, epk, workerKey.publicKey);
  const contentKey = open(keys.wrapKey, 0, wrapAad(workers, model), Buffer.from(request.recipient.wk, 'base64'));
  const plaintext = open(contentKey, 0, requestAad(workers, model), request.ciphertext);
  const inner = JSON.parse(plaintext.toString('utf-8')) as Record<string, unknown>;
  if (inner['model'] !== model) throw new Error('Inner and outer model differ');
  return {
    body: new Uint8Array(plaintext),
    model,
    recipients: workers.map((w) => getAddress(w)),
    buyer: binding?.buyer ?? null,
    channel: binding?.channel ?? null,
    expires: binding?.expires ?? null,
    binding: binding?.hash ?? null,
    sealer: new ResponseSealer(keys.responseKey, getAddress(request.worker)),
  };
}

/**
 * Worker side: decrypt a request one of whose recipients is this worker.
 * Throws when it is not, the envelope fails authentication, or the inner
 * model differs from the outer one.
 */
export function openRequest(body: Uint8Array, workerAddress: string, workerKey: WorkerEncryptionKey): OpenedRequest {
  return decryptRequest(inspectRequest(body, workerAddress), workerKey);
}

// ── responses ──

function splitEvents(buffer: string): { events: string[]; rest: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');
  const rest = parts.pop() ?? '';
  return { events: parts.filter((event) => event.trim().length > 0), rest };
}

function eventData(event: string): string | null {
  const lines = event.split('\n').filter((line) => line.startsWith('data:'));
  if (lines.length === 0) return null;
  return lines.map((line) => line.slice(5).replace(/^ /, '')).join('\n');
}

function usageOf(data: string): UsageLike | null {
  try {
    const parsed = JSON.parse(data) as { usage?: unknown };
    return parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as UsageLike : null;
  } catch {
    return null;
  }
}

/**
 * Worker side: encrypts a response for the buyer, naming the worker so the
 * buyer picks that worker's response key (no other recipient has it).
 */
export class ResponseSealer {
  private seq = 0;
  private buffer = '';
  private ended = false;
  private lastUsage: UsageLike | null = null;
  private readonly key: Buffer;
  private readonly salt: string;
  private readonly decoder = new StringDecoder('utf8');

  constructor(base: Buffer, private readonly worker: string, salt: Buffer = randomBytes(RESPONSE_SALT_BYTES)) {
    this.key = responseKey(base, salt);
    this.salt = salt.toString('base64');
  }

  /** Seal a complete (non-streamed) body, exposing `usage` in the clear for metering. */
  sealBody(body: Uint8Array): Uint8Array {
    this.ended = true;
    const envelope: Record<string, unknown> = {
      antseed_e2e: { v: WORKER_E2E_VERSION, worker: this.worker, salt: this.salt, ct: seal(this.key, 0, responseAad(0, true), body).toString('base64') },
    };
    const usage = usageOf(Buffer.from(body).toString('utf-8'));
    if (usage) envelope['usage'] = usage;
    this.lastUsage = usage;
    return new TextEncoder().encode(JSON.stringify(envelope));
  }

  /** The usage the sealed answer reports (its last usage event, when streamed), or null before any. */
  get usage(): UsageLike | null {
    return this.lastUsage;
  }

  /** Seal upstream SSE bytes; returns the SSE bytes to send (possibly empty). */
  pushStream(chunk: Uint8Array): Uint8Array {
    // Upstream chunks can end mid-character; the decoder keeps the partial bytes for the next one.
    this.buffer += this.decoder.write(Buffer.from(chunk));
    const { events, rest } = splitEvents(this.buffer);
    this.buffer = rest;
    return new TextEncoder().encode(events.map((event) => this.sealEvent(event)).join(''));
  }

  /** Flush buffered input and emit the authenticated end marker. */
  finishStream(): Uint8Array {
    if (this.ended) return new Uint8Array(0);
    this.ended = true;
    this.buffer += this.decoder.end();
    const tail = this.buffer.trim().length > 0 ? this.sealEvent(this.buffer) : '';
    this.buffer = '';
    const seq = this.seq++;
    const ct = seal(this.key, seq, responseAad(seq, true), new Uint8Array(0)).toString('base64');
    return new TextEncoder().encode(`${tail}data: ${JSON.stringify({ antseed_e2e: { seq, end: true, ct, ...this.saltFor(seq) } })}\n\n`);
  }

  private sealEvent(event: string): string {
    const seq = this.seq++;
    const ct = seal(this.key, seq, responseAad(seq, false), Buffer.from(event)).toString('base64');
    let out = `data: ${JSON.stringify({ antseed_e2e: { seq, ct, ...this.saltFor(seq) } })}\n\n`;
    const data = eventData(event);
    const usage = data ? usageOf(data) : null;
    if (usage) {
      this.lastUsage = usage;
      out += `data: ${JSON.stringify({ choices: [], usage })}\n\n`;
    }
    return out;
  }

  /** The first event of a stream names the worker and carries the salt. */
  private saltFor(seq: number): { worker?: string; salt?: string } {
    return seq === 0 ? { worker: this.worker, salt: this.salt } : {};
  }
}

/** Buyer side: decrypts and authenticates a worker's response. */
export class ResponseOpener {
  private seq = 0;
  private buffer = '';
  private complete = false;
  private authenticatedUsage: UsageLike | null = null;
  private clearUsage: UsageLike | null = null;

  /** The response's own key, once its worker and salt arrived. */
  private key: Buffer | null = null;
  private answeredBy: string | null = null;
  private readonly decoder = new StringDecoder('utf8');

  /** Response base keys by lowercase recipient address. */
  constructor(private readonly bases: ReadonlyMap<string, Buffer>) {}

  /** The response key the first sealed bytes name; kept only once they open under it. */
  private keyFor(worker: unknown, salt: unknown): { key: Buffer; worker: string } {
    if (typeof worker !== 'string') throw new Error('Worker response does not name its worker');
    const base = this.bases.get(worker.toLowerCase());
    if (!base) throw new Error('Worker response names a worker the request was not encrypted for');
    if (typeof salt !== 'string') throw new Error('Worker response is missing its salt');
    return { key: responseKey(base, Buffer.from(salt, 'base64')), worker: getAddress(worker) };
  }

  /** True once the worker's end marker verified: the whole response came from the worker. */
  get verified(): boolean {
    return this.complete;
  }

  /** The recipient that answered (once its first sealed bytes opened), else null. */
  get worker(): string | null {
    return this.answeredBy;
  }

  /** Usage inside the ciphertext, and usage the pool saw in the clear (they should match). */
  get usage(): { authenticated: UsageLike | null; clear: UsageLike | null } {
    return { authenticated: this.authenticatedUsage, clear: this.clearUsage };
  }

  /**
   * Open a complete body. JSON bodies without an envelope (errors the pool
   * itself returned) pass through unchanged and leave `verified` false;
   * anything else that fails to open throws.
   */
  openBody(body: Uint8Array): Uint8Array {
    let parsed: { antseed_e2e?: { ct?: unknown; salt?: unknown; worker?: unknown }; usage?: unknown };
    try {
      parsed = JSON.parse(Buffer.from(body).toString('utf-8')) as typeof parsed;
    } catch {
      throw new Error('Worker response is not a sealed envelope');
    }
    if (typeof parsed.antseed_e2e?.ct !== 'string') return body;
    const named = this.keyFor(parsed.antseed_e2e.worker, parsed.antseed_e2e.salt);
    const plaintext = open(named.key, 0, responseAad(0, true), Buffer.from(parsed.antseed_e2e.ct, 'base64'));
    this.key = named.key;
    this.answeredBy = named.worker;
    this.complete = true;
    this.authenticatedUsage = usageOf(plaintext.toString('utf-8'));
    this.clearUsage = parsed.usage && typeof parsed.usage === 'object' ? parsed.usage as UsageLike : null;
    return new Uint8Array(plaintext);
  }

  /** Decrypt streamed SSE bytes; returns plaintext SSE bytes for the client. Throws on tampering. */
  pushStream(chunk: Uint8Array): Uint8Array {
    this.buffer += this.decoder.write(Buffer.from(chunk));
    const { events, rest } = splitEvents(this.buffer);
    this.buffer = rest;
    let out = '';
    for (const event of events) {
      const data = eventData(event);
      if (data === null) continue;
      let parsed: { antseed_e2e?: { seq?: unknown; ct?: unknown; end?: unknown; salt?: unknown; worker?: unknown }; usage?: unknown };
      try {
        parsed = JSON.parse(data) as typeof parsed;
      } catch {
        continue;
      }
      const envelope = parsed.antseed_e2e;
      if (!envelope) {
        if (parsed.usage && typeof parsed.usage === 'object') this.clearUsage = parsed.usage as UsageLike;
        continue;
      }
      if (this.complete) throw new Error('Worker response continued after its end marker');
      if (envelope.seq !== this.seq || typeof envelope.ct !== 'string') throw new Error('Worker response events are out of order');
      const end = envelope.end === true;
      const named = this.seq === 0 ? this.keyFor(envelope.worker, envelope.salt) : { key: this.key!, worker: this.answeredBy! };
      const plaintext = open(named.key, this.seq, responseAad(this.seq, end), Buffer.from(envelope.ct, 'base64')).toString('utf-8');
      this.key = named.key;
      this.answeredBy = named.worker;
      this.seq++;
      if (end) {
        this.complete = true;
        continue;
      }
      const innerData = eventData(plaintext);
      const usage = innerData ? usageOf(innerData) : null;
      if (usage) this.authenticatedUsage = usage;
      out += `${plaintext}\n\n`;
    }
    return new TextEncoder().encode(out);
  }
}

export { toHex as workerKeyHex };

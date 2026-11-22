/**
 * Seller-blind relay: the buyer runs TLS to the upstream end to end through a
 * raw byte stream on the seller, so the seller forwards ciphertext only. The
 * seller keeps its own upstream credential and writes it into the buyer's TLS
 * session as the first record, without being able to read the session (the
 * `@antseed/keyed-relay` sidecar). The buyer never sees it.
 */

/** The service category a seller announces for a service it serves through the blind relay. */
export const BLIND_RELAY_SERVICE_CATEGORY = 'seller-blind' as const;

/** The seller route that mints a credential: `POST` with `{"model": "<service>"}`. */
export const BLIND_RELAY_CREDENTIAL_PATH = '/_antseed/blind/credential' as const;

/** The most bytes one RelayData frame carries. */
export const RELAY_DATA_MAX_BYTES = 16 * 1024;

/**
 * What the seller checks in a request before it forwards it.
 * The buyer reveals its request headers and the body's last fields (built by
 * `keyedRequestTailFields`) to the seller's sidecar, and the seller holds the
 * request until they pass. The rest of the body stays hidden.
 */
export interface KeyedRequestTerms {
  /** The field the upstream reads the output-token limit from. */
  maxTokensField: 'max_tokens' | 'max_completion_tokens';
  /** The most output tokens a request may ask for. Absent: no cap, and a request may name no limit. */
  maxTokens?: number;
  /** Further fields the seller fixes, with their values, e.g. `{"service_tier": "default"}`. */
  pinned?: Record<string, unknown>;
}

/** Body fields the keyed tail writes itself, which `pinned` may not name. */
export const KEYED_REQUEST_TAIL_FIELDS: readonly string[] = ['model', 'max_tokens', 'max_completion_tokens', 'n', 'stream', 'stream_options'];

/** The only request headers a keyed request may carry besides the seller's (lowercase). */
export const KEYED_REQUEST_HEADERS: readonly string[] = ['content-type', 'content-length', 'accept', 'user-agent'];

/** The values a keyed request body ends with. */
export interface KeyedRequestTail {
  model: string;
  /** The output-token limit, or null for none (only when the terms set no cap). */
  maxTokens: number | null;
  stream: boolean;
}

/**
 * The fields a keyed request body ends with, in this order and exactly these
 * bytes: `"model":…[,"<limit field>":…],"n":1,"stream":…[,"stream_options":{"include_usage":true}][,pinned…]`.
 * The body is `{<other fields>,<these>}`, or `{<these>}` with no others. The
 * buyer writes them last and the seller compares them byte for byte, so a
 * field hidden earlier in the body loses to them with any upstream that takes
 * the last copy of a repeated key.
 */
export function keyedRequestTailFields(terms: KeyedRequestTerms, tail: KeyedRequestTail): string {
  const fields: Array<[string, unknown]> = [['model', tail.model]];
  if (tail.maxTokens !== null) fields.push([terms.maxTokensField, tail.maxTokens]);
  fields.push(['n', 1], ['stream', tail.stream]);
  if (tail.stream) fields.push(['stream_options', { include_usage: true }]);
  for (const [name, value] of Object.entries(terms.pinned ?? {})) fields.push([name, value]);
  return fields.map(([name, value]) => `${JSON.stringify(name)}:${JSON.stringify(value)}`).join(',');
}

/** Whether `value` is well-formed keyed request terms. */
export function isKeyedRequestTerms(value: unknown): value is KeyedRequestTerms {
  if (typeof value !== 'object' || value === null) return false;
  const terms = value as Partial<KeyedRequestTerms>;
  if (terms.maxTokensField !== 'max_tokens' && terms.maxTokensField !== 'max_completion_tokens') return false;
  if (terms.maxTokens !== undefined && !(Number.isSafeInteger(terms.maxTokens) && terms.maxTokens > 0)) return false;
  if (terms.pinned === undefined) return true;
  if (typeof terms.pinned !== 'object' || terms.pinned === null || Array.isArray(terms.pinned)) return false;
  return Object.keys(terms.pinned).every((name) => !KEYED_REQUEST_TAIL_FIELDS.includes(name));
}

/** What the credential route answers: a handle only. The upstream credential never leaves the seller. */
export interface BlindRelayCredential {
  /** The seller's handle, named when opening a relay stream. */
  credentialId: string;
  upstream: {
    /** The TLS host the seller's sidecar connects to; the buyer checks its certificate. */
    host: string;
    port: number;
    /** The upstream's OpenAI-compatible base URL, e.g. `https://api.example.com/v1/openai`. */
    baseUrl: string;
    /** The upstream model the service maps to; the buyer sends it as `model`. */
    model: string;
    /** The request path the seller writes; the buyer sends only requests for it. */
    path: string;
  };
  /** What the seller checks in each request before forwarding it. */
  request: KeyedRequestTerms;
  /** Unix milliseconds. */
  expiresAt: number;
}

export interface RelayOpenPayload { streamId: string; credentialId: string }
export interface RelayDataPayload { streamId: string; data: Uint8Array }
export interface RelayClosePayload { streamId: string; reason: string }

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function writeString(parts: Uint8Array[], value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > 0xffff) throw new Error('relay field too long');
  const len = new Uint8Array(2);
  new DataView(len.buffer).setUint16(0, bytes.length);
  parts.push(len, bytes);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

class Reader {
  private offset = 0
  constructor(private readonly buf: Uint8Array) {}
  string(): string {
    if (this.offset + 2 > this.buf.length) throw new Error('truncated relay frame');
    const len = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 2).getUint16(0);
    this.offset += 2;
    if (this.offset + len > this.buf.length) throw new Error('truncated relay frame');
    const value = decoder.decode(this.buf.subarray(this.offset, this.offset + len));
    this.offset += len;
    return value;
  }
  rest(): Uint8Array {
    const value = this.buf.slice(this.offset);
    this.offset = this.buf.length;
    return value;
  }
}

export function encodeRelayOpen(payload: RelayOpenPayload): Uint8Array {
  const parts: Uint8Array[] = [];
  writeString(parts, payload.streamId);
  writeString(parts, payload.credentialId);
  return concat(parts);
}

export function decodeRelayOpen(buf: Uint8Array): RelayOpenPayload {
  const reader = new Reader(buf);
  return { streamId: reader.string(), credentialId: reader.string() };
}

/** RelayOpened carries only the stream id. */
export function encodeRelayStreamId(streamId: string): Uint8Array {
  const parts: Uint8Array[] = [];
  writeString(parts, streamId);
  return concat(parts);
}

export function decodeRelayStreamId(buf: Uint8Array): string {
  return new Reader(buf).string();
}

export function encodeRelayData(payload: RelayDataPayload): Uint8Array {
  const parts: Uint8Array[] = [];
  writeString(parts, payload.streamId);
  parts.push(payload.data);
  return concat(parts);
}

export function decodeRelayData(buf: Uint8Array): RelayDataPayload {
  const reader = new Reader(buf);
  return { streamId: reader.string(), data: reader.rest() };
}

export function encodeRelayClose(payload: RelayClosePayload): Uint8Array {
  const parts: Uint8Array[] = [];
  writeString(parts, payload.streamId);
  writeString(parts, payload.reason);
  return concat(parts);
}

export function decodeRelayClose(buf: Uint8Array): RelayClosePayload {
  const reader = new Reader(buf);
  return { streamId: reader.string(), reason: reader.string() };
}

/** Whether an offer's categories mark it as served through the blind relay. */
export function isBlindRelayOffer(offer: { categories?: readonly string[] } | null | undefined): boolean {
  return offer?.categories?.some((category) => category.toLowerCase() === BLIND_RELAY_SERVICE_CATEGORY) ?? false;
}

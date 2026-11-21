/**
 * Seller-blind relay: the seller mints a short-lived, spend-capped upstream
 * credential for one buyer, and relays raw bytes between that buyer and the
 * upstream host. The buyer runs TLS end to end through the relay, so the
 * seller forwards ciphertext only.
 */

/** The service category a seller announces for a service it serves through the blind relay. */
export const BLIND_RELAY_SERVICE_CATEGORY = 'seller-blind' as const;

/** The seller route that mints a credential: `POST` with `{"model": "<service>"}`. */
export const BLIND_RELAY_CREDENTIAL_PATH = '/_antseed/blind/credential' as const;

/** The most bytes one RelayData frame carries. */
export const RELAY_DATA_MAX_BYTES = 16 * 1024;

/** What the credential route answers. */
export interface BlindRelayCredential {
  /** The seller's handle for the credential, named when opening a relay stream. */
  credentialId: string;
  /** The upstream bearer credential. */
  credential: string;
  upstream: {
    /** The TLS host the relay connects to; the buyer checks its certificate. */
    host: string;
    port: number;
    /** The upstream's OpenAI-compatible base URL, e.g. `https://api.example.com/v1/openai`. */
    baseUrl: string;
    /** The upstream model the service maps to; the buyer sends it as `model`. */
    model: string;
  };
  /** Unix milliseconds. */
  expiresAt: number;
  /** The upstream spend cap of this credential, in USD. */
  spendLimitUsd: number;
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

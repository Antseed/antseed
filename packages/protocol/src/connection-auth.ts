/**
 * Connection auth envelope: the signed `intro`/`hello` line that opens every
 * transport connection. Signatures are EIP-191 personal-sign over
 * MSG_SIGNING_DOMAIN + buildConnectionAuthPayload(...). Verification (replay
 * guard, clock skew) lives in @antseed/node; this module is the wire format.
 */

export type InitialWireType = 'intro' | 'hello';

export interface ConnectionAuthEnvelope {
  peerId: string;
  ts: number;
  nonce: string;
  sig: string;
  /**
   * Payload version. v2 signatures also cover the wire capabilities and enc
   * public key (buildConnectionAuthPayloadV2), so stripping or tampering with
   * either — or with this marker — breaks the signature. Absent = legacy v1.
   */
  v?: 2;
}

/** Domain prefix for EIP-191 message signing (see signUtf8 in @antseed/node). */
export const MSG_SIGNING_DOMAIN = 'antseed-msg-v1:';

export const INTRO_AUTH_MAX_SKEW_MS = 30_000;

export function buildConnectionAuthPayload(
  type: InitialWireType,
  peerId: string,
  ts: number,
  nonce: string,
): string {
  return `${type}|${peerId}|${ts}|${nonce}`;
}

/**
 * v2 payload: binds the advertised capabilities and enc public key ('-' when
 * absent). Capabilities are JSON-encoded — an unambiguous canonical form, so
 * no two distinct arrays (or array/merged-string confusions) share a payload.
 */
export function buildConnectionAuthPayloadV2(
  type: InitialWireType,
  peerId: string,
  ts: number,
  nonce: string,
  capabilities: string[],
  encPub: string | null,
): string {
  return `${type}|${peerId}|${ts}|${nonce}|caps=${JSON.stringify(capabilities)}|enc=${encPub ?? '-'}`;
}

/**
 * Signed-SDP payload (transport.signed-sdp.v1). Signing the SDP hash binds
 * the DTLS fingerprint it contains to the peer's wallet identity.
 */
export function buildSdpAuthPayload(
  peerId: string,
  ts: number,
  nonce: string,
  descriptionType: string,
  sdpSha256Hex: string,
): string {
  return `sdp|${peerId}|${ts}|${nonce}|${descriptionType}|${sdpSha256Hex}`;
}

/**
 * TCP encryption handshake (transport.tcp-enc.v1): the `intro` line carries a
 * signed ephemeral X25519 key bound to the intro's ts/nonce; the responder's
 * `enc-ack` signature also covers the initiator's nonce for freshness and
 * mutual authentication.
 */
export interface TcpEncOffer {
  /** Ephemeral X25519 public key, 32 bytes hex. */
  pub: string;
  /** Wallet signature over buildTcpEncInitPayload(...). */
  sig: string;
}

export interface TcpEncAckMessage {
  type: 'enc-ack';
  peerId: string;
  ts: number;
  nonce: string;
  /** Responder's ephemeral X25519 public key, 32 bytes hex. */
  pub: string;
  /** Wallet signature over buildTcpEncAckPayload(...). */
  sig: string;
}

export function buildTcpEncInitPayload(
  peerId: string,
  ts: number,
  nonce: string,
  pubHex: string,
): string {
  return `enc-init|${peerId}|${ts}|${nonce}|${pubHex}`;
}

export function buildTcpEncAckPayload(
  peerId: string,
  ts: number,
  nonce: string,
  pubHex: string,
  initiatorNonce: string,
): string {
  return `enc-ack|${peerId}|${ts}|${nonce}|${pubHex}|${initiatorNonce}`;
}

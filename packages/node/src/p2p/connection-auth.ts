import { randomBytes } from 'node:crypto';
import type { Wallet } from 'ethers';
import type { PeerId } from '../types/peer.js';
import { toPeerId } from '../types/peer.js';
import { signUtf8, verifyUtf8 } from './identity.js';
import {
  buildConnectionAuthPayload,
  buildConnectionAuthPayloadV2,
  buildSdpAuthPayload,
  buildTcpEncAckPayload,
  buildTcpEncInitPayload,
  INTRO_AUTH_MAX_SKEW_MS,
  type ConnectionAuthEnvelope,
  type InitialWireType,
  type TcpEncAckMessage,
  type TcpEncOffer,
} from '@antseed/protocol/connection-auth';
import { sha256Hex, X25519_PUB_HEX_REGEX } from './secure-channel.js';

export { INTRO_AUTH_MAX_SKEW_MS };
export type { ConnectionAuthEnvelope, InitialWireType, TcpEncAckMessage, TcpEncOffer };

export interface VerifyConnectionAuthOptions {
  type: InitialWireType;
  auth: ConnectionAuthEnvelope | null | undefined;
  /** Capabilities exactly as received on the wire; required to check v2 envelopes. */
  wireCapabilities?: unknown;
  /** Enc public key exactly as received on the wire. */
  wireEncPub?: string | null;
  nowMs?: number;
  maxSkewMs?: number;
  replayGuard?: NonceReplayGuard;
}

export interface VerifyConnectionAuthResult {
  ok: boolean;
  peerId?: PeerId;
  reason?: string;
}

const NONCE_SIZE_BYTES = 16;
const SIG_HEX_LEN = 130;
const NONCE_HEX_REGEX = /^[0-9a-f]{32}$/;
const SIG_HEX_REGEX = /^[0-9a-f]{130}$/;

function buildReplayKey(peerId: PeerId, nonce: string): string {
  return `${peerId}:${nonce}`;
}

/**
 * Tracks recently seen nonces to reject replayed intro messages.
 */
export class NonceReplayGuard {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs = INTRO_AUTH_MAX_SKEW_MS * 2,
    private readonly maxEntries = 20_000,
  ) {}

  checkAndRemember(peerId: PeerId, nonce: string, nowMs = Date.now()): boolean {
    this.evictExpired(nowMs);
    const key = buildReplayKey(peerId, nonce);
    const existingExpiry = this.seen.get(key);
    if (existingExpiry && existingExpiry > nowMs) {
      return false;
    }

    this.seen.set(key, nowMs + this.ttlMs);
    if (this.seen.size > this.maxEntries) {
      const overflow = this.seen.size - this.maxEntries;
      let removed = 0;
      for (const oldestKey of this.seen.keys()) {
        this.seen.delete(oldestKey);
        removed++;
        if (removed >= overflow) {
          break;
        }
      }
    }
    return true;
  }

  private evictExpired(nowMs: number): void {
    for (const [key, expiresAt] of this.seen) {
      if (expiresAt <= nowMs) {
        this.seen.delete(key);
      }
    }
  }
}

/** Values the v2 envelope signature additionally covers. */
export interface TransportBinding {
  capabilities: string[];
  encPub?: string | null;
}

export function buildConnectionAuthEnvelope(
  type: InitialWireType,
  peerId: PeerId,
  wallet: Wallet,
  nowMs = Date.now(),
  bind?: TransportBinding,
): ConnectionAuthEnvelope {
  const nonce = randomBytes(NONCE_SIZE_BYTES).toString('hex');
  if (bind) {
    const payload = buildConnectionAuthPayloadV2(type, peerId, nowMs, nonce, bind.capabilities, bind.encPub ?? null);
    return { peerId, ts: nowMs, nonce, sig: signUtf8(wallet, payload), v: 2 };
  }
  const payload = buildConnectionAuthPayload(type, peerId, nowMs, nonce);
  return { peerId, ts: nowMs, nonce, sig: signUtf8(wallet, payload) };
}

export function verifyConnectionAuthEnvelope(
  options: VerifyConnectionAuthOptions,
): VerifyConnectionAuthResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? INTRO_AUTH_MAX_SKEW_MS;
  const auth = options.auth;
  if (!auth || typeof auth !== 'object') {
    return { ok: false, reason: 'missing auth envelope' };
  }

  let peerId: PeerId;
  try {
    peerId = toPeerId(auth.peerId);
  } catch {
    return { ok: false, reason: 'invalid peerId' };
  }

  if (!Number.isInteger(auth.ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(nowMs - auth.ts) > maxSkewMs) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }

  if (!NONCE_HEX_REGEX.test(auth.nonce)) {
    return { ok: false, reason: 'invalid nonce format' };
  }
  if (!SIG_HEX_REGEX.test(auth.sig) || auth.sig.length !== SIG_HEX_LEN) {
    return { ok: false, reason: 'invalid signature format' };
  }

  if (options.replayGuard && !options.replayGuard.checkAndRemember(peerId, auth.nonce, nowMs)) {
    return { ok: false, reason: 'replayed intro auth nonce' };
  }

  let payload: string;
  if (auth.v === undefined) {
    payload = buildConnectionAuthPayload(options.type, peerId, auth.ts, auth.nonce);
  } else if (auth.v === 2) {
    const caps = options.wireCapabilities ?? [];
    if (!Array.isArray(caps) || caps.some((c) => typeof c !== 'string')) {
      return { ok: false, reason: 'invalid capabilities for v2 envelope' };
    }
    payload = buildConnectionAuthPayloadV2(
      options.type,
      peerId,
      auth.ts,
      auth.nonce,
      caps as string[],
      options.wireEncPub ?? null,
    );
  } else {
    return { ok: false, reason: 'unsupported envelope version' };
  }

  const valid = verifyUtf8(peerId, payload, auth.sig);
  if (!valid) {
    return { ok: false, reason: 'signature verification failed' };
  }

  return { ok: true, peerId };
}

/** Signed envelope for an outgoing `sdp` signaling message. */
export function buildSdpAuthEnvelope(
  peerId: PeerId,
  wallet: Wallet,
  descriptionType: string,
  sdp: string,
  nowMs = Date.now(),
): ConnectionAuthEnvelope {
  const nonce = randomBytes(NONCE_SIZE_BYTES).toString('hex');
  const payload = buildSdpAuthPayload(peerId, nowMs, nonce, descriptionType, sha256Hex(sdp));
  return { peerId, ts: nowMs, nonce, sig: signUtf8(wallet, payload) };
}

export interface VerifySdpAuthOptions {
  auth: ConnectionAuthEnvelope | null | undefined;
  expectedPeerId: PeerId;
  descriptionType: string;
  sdp: string;
  nowMs?: number;
  maxSkewMs?: number;
  replayGuard?: NonceReplayGuard;
}

/** Verify the signed envelope on a received `sdp` signaling message. */
export function verifySdpAuthEnvelope(
  options: VerifySdpAuthOptions,
): VerifyConnectionAuthResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? INTRO_AUTH_MAX_SKEW_MS;
  const auth = options.auth;
  if (!auth || typeof auth !== 'object') {
    return { ok: false, reason: 'missing sdp auth envelope' };
  }

  let peerId: PeerId;
  try {
    peerId = toPeerId(auth.peerId);
  } catch {
    return { ok: false, reason: 'invalid peerId' };
  }
  if (peerId !== options.expectedPeerId) {
    return { ok: false, reason: 'sdp auth peerId does not match connection peer' };
  }

  if (!Number.isInteger(auth.ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(nowMs - auth.ts) > maxSkewMs) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }
  if (!NONCE_HEX_REGEX.test(auth.nonce)) {
    return { ok: false, reason: 'invalid nonce format' };
  }
  if (!SIG_HEX_REGEX.test(auth.sig) || auth.sig.length !== SIG_HEX_LEN) {
    return { ok: false, reason: 'invalid signature format' };
  }
  if (options.replayGuard && !options.replayGuard.checkAndRemember(peerId, auth.nonce, nowMs)) {
    return { ok: false, reason: 'replayed sdp auth nonce' };
  }

  const payload = buildSdpAuthPayload(
    peerId,
    auth.ts,
    auth.nonce,
    options.descriptionType,
    sha256Hex(options.sdp),
  );
  if (!verifyUtf8(peerId, payload, auth.sig)) {
    return { ok: false, reason: 'sdp signature verification failed' };
  }

  return { ok: true, peerId };
}

/** `enc` offer for an `intro` line, bound to the intro envelope's ts/nonce. */
export function buildTcpEncOffer(
  wallet: Wallet,
  peerId: PeerId,
  introTs: number,
  introNonce: string,
  publicKeyHex: string,
): TcpEncOffer {
  const payload = buildTcpEncInitPayload(peerId, introTs, introNonce, publicKeyHex);
  return { pub: publicKeyHex, sig: signUtf8(wallet, payload) };
}

/** Verify an `enc` offer; skew/replay were already checked on the intro envelope. */
export function verifyTcpEncOffer(options: {
  offer: TcpEncOffer | null | undefined;
  peerId: PeerId;
  introTs: number;
  introNonce: string;
}): VerifyConnectionAuthResult {
  const offer = options.offer;
  if (!offer || typeof offer !== 'object') {
    return { ok: false, reason: 'missing enc offer' };
  }
  if (typeof offer.pub !== 'string' || !X25519_PUB_HEX_REGEX.test(offer.pub)) {
    return { ok: false, reason: 'invalid enc public key' };
  }
  if (typeof offer.sig !== 'string' || !SIG_HEX_REGEX.test(offer.sig)) {
    return { ok: false, reason: 'invalid enc signature format' };
  }
  const payload = buildTcpEncInitPayload(options.peerId, options.introTs, options.introNonce, offer.pub);
  if (!verifyUtf8(options.peerId, payload, offer.sig)) {
    return { ok: false, reason: 'enc offer signature verification failed' };
  }
  return { ok: true, peerId: options.peerId };
}

/** Responder's `enc-ack`; signing the initiator's nonce makes it fresh and handshake-bound. */
export function buildTcpEncAck(
  wallet: Wallet,
  peerId: PeerId,
  publicKeyHex: string,
  initiatorNonce: string,
  nowMs = Date.now(),
): TcpEncAckMessage {
  const nonce = randomBytes(NONCE_SIZE_BYTES).toString('hex');
  const payload = buildTcpEncAckPayload(peerId, nowMs, nonce, publicKeyHex, initiatorNonce);
  return {
    type: 'enc-ack',
    peerId,
    ts: nowMs,
    nonce,
    pub: publicKeyHex,
    sig: signUtf8(wallet, payload),
  };
}

/** Verify an `enc-ack` line received by the initiator. */
export function verifyTcpEncAck(options: {
  ack: Partial<TcpEncAckMessage> | null | undefined;
  expectedPeerId: PeerId;
  initiatorNonce: string;
  nowMs?: number;
  maxSkewMs?: number;
}): VerifyConnectionAuthResult {
  const nowMs = options.nowMs ?? Date.now();
  const maxSkewMs = options.maxSkewMs ?? INTRO_AUTH_MAX_SKEW_MS;
  const ack = options.ack;
  if (!ack || typeof ack !== 'object' || ack.type !== 'enc-ack') {
    return { ok: false, reason: 'missing enc-ack' };
  }

  let peerId: PeerId;
  try {
    peerId = toPeerId(ack.peerId ?? '');
  } catch {
    return { ok: false, reason: 'invalid peerId' };
  }
  if (peerId !== options.expectedPeerId) {
    return { ok: false, reason: 'enc-ack peerId does not match dialed peer' };
  }
  if (!Number.isInteger(ack.ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(nowMs - (ack.ts as number)) > maxSkewMs) {
    return { ok: false, reason: 'timestamp outside allowed skew' };
  }
  if (typeof ack.nonce !== 'string' || !NONCE_HEX_REGEX.test(ack.nonce)) {
    return { ok: false, reason: 'invalid nonce format' };
  }
  if (typeof ack.pub !== 'string' || !X25519_PUB_HEX_REGEX.test(ack.pub)) {
    return { ok: false, reason: 'invalid enc public key' };
  }
  if (typeof ack.sig !== 'string' || !SIG_HEX_REGEX.test(ack.sig)) {
    return { ok: false, reason: 'invalid signature format' };
  }

  const payload = buildTcpEncAckPayload(peerId, ack.ts as number, ack.nonce, ack.pub, options.initiatorNonce);
  if (!verifyUtf8(peerId, payload, ack.sig)) {
    return { ok: false, reason: 'enc-ack signature verification failed' };
  }
  return { ok: true, peerId };
}

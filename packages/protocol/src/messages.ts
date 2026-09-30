export enum MessageType {
  HandshakeInit = 0x01,
  HandshakeAck = 0x02,
  Ping = 0x10,
  Pong = 0x11,
  HttpRequest = 0x20,
  HttpResponse = 0x21,
  HttpResponseChunk = 0x22,
  HttpResponseEnd = 0x23,
  HttpResponseError = 0x24,
  // Chunked request upload (buyer→seller body streaming)
  HttpRequestChunk = 0x25,
  HttpRequestEnd   = 0x26,
  HttpResponseAck = 0x27,
  HttpRequestCancel = 0x28,

  // --- Payment Protocol (0x50-0x5F) ---
  SpendingAuth = 0x50,
  AuthAck = 0x51,
  FreeUsageOpen = 0x52,
  FreeUsageAuth = 0x53,
  FreeUsageAck = 0x54,
  NeedFreeUsageAuth = 0x55,
  PaymentRequired = 0x56,
  NeedAuth = 0x58,
  CloseChannelRequest = 0x59,
  CloseChannelResult = 0x5A,

  // Report message types
  PeerReport = 0x60,
  ReportAck = 0x61,

  // Rating message types
  PeerRating = 0x70,
  RatingQuery = 0x71,
  RatingResponse = 0x72,

  // Verification / attestation protocol (0x80-0x8F)
  VerificationResponseAuth = 0x80,

  // 0x90-0x9F reserved: delegated-verification protocol (feat/verifier-network)

  // Deposit sweep protocol (0xA0-0xAF)
  SweepRequest = 0xA0,
  SweepReceipt = 0xA1,

  Disconnect = 0xF0,
  Error = 0xFF,
}

import type { UnitBillingUsageReportV1 } from "./billing.js";

export const CONNECTION_CAPABILITY_RESPONSE_AUTH_V1 = 'verification.response-auth.v1' as const;
export const CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1 = 'payments.relays-sweeps.v1' as const;
/** Seller honours buyer-initiated cooperative channel close (0x59 / 0x5A). */
export const CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1 = 'payments.cooperative-close.v1' as const;
/**
 * Seller runs periodic model health self-checks and unadvertises services
 * that stop working, so its announced service list reflects live health.
 */
export const CONNECTION_CAPABILITY_MODEL_HEALTH_V1 = 'seller.model-health.v1' as const;
/** Peer signs WebRTC SDP over the signaling socket (DTLS fingerprint binding). */
export const CONNECTION_CAPABILITY_SIGNED_SDP_V1 = 'transport.signed-sdp.v1' as const;
/** Peer supports the encrypted TCP transport handshake (X25519 + AES-256-GCM). */
export const CONNECTION_CAPABILITY_TCP_ENC_V1 = 'transport.tcp-enc.v1' as const;
/** Peer has a working WebRTC stack and accepts `hello` signaling. */
export const CONNECTION_CAPABILITY_WEBRTC_V1 = 'transport.webrtc.v1' as const;

export function peerRelaysSweeps(peer: { capabilities?: string[]; metadata?: { capabilities?: string[] } }): boolean {
  return peer.capabilities?.includes(CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1) === true
    || peer.metadata?.capabilities?.includes(CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1) === true;
}

export function peerSupportsCooperativeClose(
  peer: { capabilities?: string[]; metadata?: { capabilities?: string[] } },
): boolean {
  return peer.capabilities?.includes(CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1) === true
    || peer.metadata?.capabilities?.includes(CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1) === true;
}

export function peerRunsModelHealthChecks(
  peer: { capabilities?: string[]; metadata?: { capabilities?: string[] } },
): boolean {
  return peer.capabilities?.includes(CONNECTION_CAPABILITY_MODEL_HEALTH_V1) === true
    || peer.metadata?.capabilities?.includes(CONNECTION_CAPABILITY_MODEL_HEALTH_V1) === true;
}

export interface FramedMessage {
  type: MessageType;
  messageId: number;
  payload: Uint8Array;
}

export const FRAME_HEADER_SIZE = 9;
export const MAX_PAYLOAD_SIZE = 64 * 1024 * 1024;

// ─── Bilateral Payment Messages ─────────────────────────────────

/**
 * Buyer authorizes spending via a single EIP-712 SpendingAuth signature.
 * The signature covers channelId, cumulativeAmount, and metadataHash.
 */
export interface SpendingAuthPayload {
  channelId: string;
  cumulativeAmount: string;
  metadataHash: string;         // bytes32 hex
  metadata: string;             // hex-encoded abi.encode(version, inputTokens, outputTokens, requestCount, services[])
  spendingAuthSig: string;      // EIP-712 SpendingAuth signature (covers amount + metadata)
  // Only for initial reserve
  reserveSalt?: string;
  reserveMaxAmount?: string;
  reserveDeadline?: number;
}

/**
 * Seller acknowledges the spending authorization was reserved on-chain.
 */
export interface AuthAckPayload {
  channelId: string;
}

/**
 * Buyer opens a zero-price usage channel. This does not require deposits.
 */
export interface FreeUsageOpenPayload {
  channelId: string;
  salt: string;
  deadline: number;
  openSig: string;
}

/**
 * Buyer authorizes a cumulative zero-price usage record after the seller reports
 * usage for a served request.
 */
export interface FreeUsageAuthPayload {
  channelId: string;
  cumulativeInputTokens: string;
  cumulativeOutputTokens: string;
  sequence: string;
  metadataHash: string;
  metadata: string;
  deadline: number;
  usageSig: string;
}

/**
 * Seller acknowledges a free usage channel/open or record was accepted for
 * on-chain reporting.
 */
export interface FreeUsageAckPayload {
  channelId: string;
  acceptedSequence?: string;
}

/**
 * Seller asks the buyer to sign zero-price usage for a completed request.
 */
export interface NeedFreeUsageAuthPayload {
  channelId: string;
  requiredSequence: string;
  currentAcceptedSequence: string;
  requestId?: string;
  inputTokens?: string;
  outputTokens?: string;
  service?: string;
}

/**
 * Seller tells buyer what's needed to start a payment session.
 * Sent via PaymentMux alongside the HTTP 402 response.
 */
export interface PaymentRequiredPayload {
  minBudgetPerRequest: string;
  suggestedAmount: string;
  requestId: string;
  inputUsdPerMillion?: number;
  outputUsdPerMillion?: number;
  cachedInputUsdPerMillion?: number;
  /**
   * For budget-exhausted 402s on an existing channel: the cumulative
   * amount the buyer must sign to catch up with the seller's recorded
   * spend and unblock further requests. Absent for pre-session 402s.
   */
  requiredCumulativeAmount?: string;
  /** Seller-side cumulative spend at the time the 402 was emitted. */
  currentSpent?: string;
  /** Seller-side last-accepted cumulative at the time the 402 was emitted. */
  currentAcceptedCumulative?: string;
  /** Channel ID for the exhausted session (so buyer can match it locally). */
  channelId?: string;
  /**
   * On-chain reserve ceiling for this channel. When present and the seller's
   * `requiredCumulativeAmount` exceeds it, the channel is permanently
   * exhausted and the buyer must retire it and open a new one — no amount
   * of additional signing on the same channel will be accepted.
   */
  reserveMaxAmount?: string;
  /**
   * Stable machine-readable code so callers can switch on it without coupling
   * to internal phrasing. Only set on irrecoverable 402s today.
   */
  code?: PaymentRequiredCode;
}

export const PAYMENT_CODE_CHANNEL_EXHAUSTED = 'channel_exhausted' as const;
export type PaymentRequiredCode = typeof PAYMENT_CODE_CHANNEL_EXHAUSTED;

/**
 * Seller tells buyer that the current cumulative authorization is insufficient.
 * After every served request the seller includes the cost of that request so
 * the buyer can validate before signing a new SpendingAuth.
 */
export interface NeedAuthPayload {
  channelId: string;
  requiredCumulativeAmount: string;
  currentAcceptedCumulative: string;
  deposit: string;
  /** requestId of the request whose cost is reported below. */
  requestId?: string;
  /** Seller-computed cost for the last request (USDC base units). */
  lastRequestCost?: string;
  /** Total input tokens consumed by the last request (provider-style total — may include cached). */
  inputTokens?: string;
  /** Output tokens consumed by the last request. */
  outputTokens?: string;
  /** Cached input tokens consumed by the last request. */
  cachedInputTokens?: string;
  /**
   * Fresh (non-cached) input tokens consumed by the last request.
   * Sent explicitly by the seller so the buyer doesn't have to guess at
   * OpenAI-vs-Anthropic cached-token semantics (OpenAI: prompt_tokens
   * includes cached; Anthropic: input_tokens excludes cached). When absent,
   * the buyer falls back to `inputTokens - cachedInputTokens` (OpenAI
   * convention) for backward compat with older sellers.
   */
  freshInputTokens?: string;
  /** Service/model name for service-specific pricing validation. */
  service?: string;
  /** Compact v1 unit billing evidence for cost validation. */
  billingUsage?: UnitBillingUsageReportV1;
}

// ─── Cooperative Channel Close Messages ─────────────────────────

/**
 * Buyer asks the seller to close a payment channel now, skipping the on-chain
 * `requestClose()` → 15-minute grace → `withdraw()` path.
 *
 * The buyer MAY attach its latest SpendingAuth so the seller can close at that
 * cumulative even if the seller never received it (e.g. the frame was lost on
 * disconnect). The seller closes at whichever cumulative is higher — its own
 * last-accepted auth or the one attached here — so neither side can use this
 * message to under-report spend.
 *
 * All four auth fields travel together: either all are present or none are.
 */
export interface CloseChannelRequestPayload {
  version: 1;
  /** Channel the buyer wants closed. Must match the seller's active channel. */
  channelId: string;
  /** Cumulative USDC (base units) the attached signature authorizes. */
  cumulativeAmount?: string;
  /** bytes32 keccak256 of `metadata`. */
  metadataHash?: string;
  /** Hex-encoded abi.encode(...) usage metadata covered by the signature. */
  metadata?: string;
  /** EIP-712 SpendingAuth signature over (channelId, cumulativeAmount, metadataHash). */
  spendingAuthSig?: string;
}

/** Why a seller declined to close a channel on request. */
export const CLOSE_CHANNEL_REJECT_CODES = [
  /** Seller is still serving requests for this buyer — retry shortly. */
  'busy',
  /** Seller has served work the buyer has not signed for yet. A NeedAuth was
   *  sent alongside this result; sign `requiredCumulativeAmount` and retry. */
  'pending_auth',
  /** No active channel for this buyer, or `channelId` does not match it. */
  'no_channel',
  /** The attached SpendingAuth failed verification. */
  'invalid_auth',
  /** The on-chain close() call failed. `reason` carries the revert text. */
  'close_failed',
  /** Seller has no payment manager configured. */
  'unsupported',
] as const;

export type CloseChannelRejectCode = typeof CLOSE_CHANNEL_REJECT_CODES[number];

/**
 * Seller's answer to a CloseChannelRequest. On success it carries the
 * transaction hash of the on-chain `close()`; on refusal, a stable code the
 * buyer can switch on.
 */
export interface CloseChannelResultPayload {
  version: 1;
  channelId: string;
  status: 'closed' | 'rejected';
  /** Present when status === 'closed'. */
  txHash?: string;
  /** Cumulative the channel was closed at (base units). Present on success. */
  finalAmount?: string;
  /** Present when status === 'rejected'. */
  code?: CloseChannelRejectCode;
  /** Human-readable detail. Never load-bearing — switch on `code`. */
  reason?: string;
  /** Hint for 'busy' / 'pending_auth': wait this long before retrying. */
  retryAfterMs?: number;
  /** For 'pending_auth': the cumulative the buyer must sign before retrying. */
  requiredCumulativeAmount?: string;
}

// ─── Deposit Sweep Messages ─────────────────────────────────────

/**
 * Buyer broadcasts a signed gasless deposit sweep for permissionless relayers
 * (sellers by default) to submit on-chain. Carries everything
 * AntseedDepositRelay.sweepDeposit needs; the relayer earns the contract's
 * fixed, immutable FEE in USDC. The single EIP-3009 signature — addressed to
 * the relay contract — is the buyer's consent to those terms. Replay-safe via
 * the EIP-3009 nonce; losing a submission race is harmless.
 */
export interface SweepRequestPayload {
  version: 1;
  evmChainId: number;
  /** AntseedDepositRelay address the buyer signed against. Relayers must only
   *  submit when this matches their own configured relay address. */
  relayAddress: string;
  from: string;
  /** Total USDC pulled via EIP-3009, base units (uint256 decimal string). */
  amount: string;
  validAfter: number;
  validBefore: number;
  /** EIP-3009 authorization nonce (bytes32 hex). Also the correlation key. */
  nonce: string;
  /** Buyer signature over the USDC ReceiveWithAuthorization typed data. */
  sig3009: string;
}

export type SweepReceiptStatus = 'submitted' | 'confirmed' | 'rejected';

/**
 * Optional relayer progress report for a SweepRequest, correlated by the
 * EIP-3009 nonce. Purely informational — the buyer's source of truth is its
 * Deposits balance on-chain.
 */
export interface SweepReceiptPayload {
  version: 1;
  authNonce: string;
  status: SweepReceiptStatus;
  txHash?: string;
  reason?: string;
}

// ─── Bilateral Verification Messages ───────────────────────────

/**
 * Seller-signed commitment for one completed inference response.
 * Carries hashes and context only; plaintext request/response bytes stay local.
 */
export interface ResponseAuthPayload {
  version: 1;
  requestId: string;
  channelId?: string;
  buyerPeerId: string;
  sellerPeerId: string;
  advertisedService: string;
  provider: string;
  statusCode: number;
  requestHash: string;
  responseHash: string;
  responseStartedAt: number;
  responseCompletedAt: number;
  signature: string;
}

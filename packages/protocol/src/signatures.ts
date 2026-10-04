import {
  type AbstractSigner,
  type TypedDataDomain,
  AbiCoder,
  ZeroHash,
  hexlify,
  id,
  keccak256,
  randomBytes,
  toBeHex,
} from 'ethers';

// =========================================================================
// EIP-712 Types — AntSeed SpendingAuth (cumulative payment authorization)
// =========================================================================

export const SPENDING_AUTH_TYPES = {
  SpendingAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'cumulativeAmount', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
  ],
};

export const RESERVE_AUTH_TYPES = {
  ReserveAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'maxAmount', type: 'uint128' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const SET_OPERATOR_TYPES = {
  SetOperator: [
    { name: 'operator', type: 'address' },
    { name: 'nonce', type: 'uint256' },
  ],
};

export const FREE_USAGE_OPEN_TYPES = {
  FreeUsageOpen: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

export const FREE_USAGE_AUTH_TYPES = {
  FreeUsageAuth: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'sequence', type: 'uint256' },
    { name: 'metadataHash', type: 'bytes32' },
    { name: 'deadline', type: 'uint256' },
  ],
};

/** AntseedReferrals invite (signed by the referrer; see `ReferralInvite`). */
export const INVITE_TYPES = {
  Invite: [
    { name: 'issuedEpoch', type: 'uint256' },
    { name: 'index', type: 'uint256' },
  ],
};

// =========================================================================
// EIP-712 Types — EIP-3009 (USDC)
// =========================================================================

/**
 * EIP-3009 receiveWithAuthorization typed data, as implemented by Circle's
 * FiatToken (USDC). Must match the token's typehash exactly:
 *   ReceiveWithAuthorization(address from,address to,uint256 value,
 *     uint256 validAfter,uint256 validBefore,bytes32 nonce)
 *
 * For deposit sweeps this is the ONLY buyer signature: addressing the
 * authorization to the AntseedDepositRelay contract is consent to its
 * public, immutable fixed FEE.
 */
export const RECEIVE_WITH_AUTHORIZATION_TYPES = {
  ReceiveWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

// =========================================================================
// Message interfaces
// =========================================================================

export interface SpendingAuthMessage {
  channelId: string;
  cumulativeAmount: bigint;
  metadataHash: string; // bytes32 hex
}

export interface ReserveAuthMessage {
  channelId: string;
  maxAmount: bigint;
  deadline: bigint;
}

export interface SetOperatorMessage {
  operator: string;
  nonce: bigint;
}

export interface FreeUsageOpenMessage {
  channelId: string;
  deadline: bigint;
}

export interface FreeUsageAuthMessage {
  channelId: string;
  sequence: bigint;
  metadataHash: string;
  deadline: bigint;
}

export interface ReceiveAuthorizationMessage {
  from: string;
  to: string;
  value: bigint;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string; // bytes32 hex
}

// =========================================================================
// Metadata encoding
// =========================================================================

/**
 * SpendingAuth metadata v3.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     uint256 cumulativeOutputImages,
 *     ServiceTotal[] services
 *   )
 *
 * The first four fields intentionally match v1/v2 so legacy decoders can read
 * aggregate token/request counters by decoding only those fields. Service
 * entries are buyer-side attribution metadata for indexers: input tokens
 * include cached input, with cached input broken out separately. The service
 * tuple appends cumulativeOutputImages after the v2 fields; decoders must
 * switch on the leading version word before decoding the services array.
 *
 * Generated images are counted twice, deliberately:
 *   - cumulativeOutputImages holds the raw image count (ground truth),
 *   - cumulativeOutputTokens is additionally credited a flat
 *     OUTPUT_IMAGE_TOKEN_EQUIVALENT per image, so token counters reflect
 *     image work. Real text tokens are recoverable as
 *     cumulativeOutputTokens - cumulativeOutputImages * OUTPUT_IMAGE_TOKEN_EQUIVALENT.
 *
 * Service cumulativeAmount values may be lower than the top-level
 * cumulativeAmount because the buyer can sign reserve headroom, cap a
 * per-request amount, or extend auth without attributing that delta to a
 * specific service.
 */

/**
 * A referral invite: the EIP-712 `Invite(uint256 issuedEpoch,uint256 index)`
 * signed by the referrer in the AntseedReferrals domain, as an EIP-2098
 * compact signature (r, vs). The referrer is recovered from the signature.
 */
export interface ReferralInvite {
  epoch: bigint;
  index: bigint;
  /** bytes32 hex */
  r: string;
  /** bytes32 hex */
  vs: string;
}

/**
 * Buyer-side usage attribution, appended to both SpendingAuth and FreeUsage
 * metadata as five extra ABI head words after the services-array offset:
 *
 *   abi.encode(<head words>, ServiceTotal[] services, bytes32 clientId,
 *              uint256 inviteEpoch, uint256 inviteIndex, bytes32 inviteR, bytes32 inviteVs)
 *
 * Offsets are absolute, so every decoder that stops at the services array
 * keeps working (see `decodeMetadataAttribution`). AntseedStatsV2 forwards a
 * present invite (non-zero r or vs) to AntseedReferrals, which binds the
 * buyer to the invite's signer, and credits the buyer's recognized usage to
 * the client. The tail is covered by metadataHash, so the binding is
 * buyer-signed, covers free usage, and costs no extra transaction.
 *
 * - clientId: ERC-8004 agent id (as bytes32) of the client software that
 *   produced the usage (zero when none).
 * - invite: carried until the referral is bound; afterwards the buyer sends
 *   zeros there and keeps the tail for clientId.
 */
export interface UsageAttribution {
  clientId?: string;
  invite?: ReferralInvite;
}

/** Encode an ERC-8004 agent id as the bytes32 clientId word. */
export function clientIdFromAgentId(agentId: bigint | number): string {
  const id = BigInt(agentId);
  if (id <= 0n) throw new Error('client agent id must be positive');
  return toBeHex(id, 32);
}

/** ERC-8004 agent id carried by a bytes32 clientId (0n when unset). */
export function clientAgentId(clientId: string): bigint {
  return BigInt(clientId);
}

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const ATTRIBUTION_TAIL_TYPES = ['bytes32', 'uint256', 'uint256', 'bytes32', 'bytes32'];

/**
 * ABI types and values of a metadata blob's optional attribution tail, to
 * append after the services array. Empty when neither a client nor an invite
 * is set, so the encoding is unchanged.
 */
export function attributionTailAbi(attribution: UsageAttribution | undefined): { types: string[]; values: unknown[] } {
  const clientId = attribution?.clientId ?? ZeroHash;
  if (!BYTES32.test(clientId)) throw new Error('clientId must be a bytes32 hex string');
  const invite = attribution?.invite;
  if (invite && (!BYTES32.test(invite.r) || !BYTES32.test(invite.vs))) throw new Error('invite r and vs must be bytes32 hex strings');
  if (clientId === ZeroHash && !invite) return { types: [], values: [] };
  return {
    types: ATTRIBUTION_TAIL_TYPES,
    values: [clientId, invite?.epoch ?? 0n, invite?.index ?? 0n, invite?.r ?? ZeroHash, invite?.vs ?? ZeroHash],
  };
}

/**
 * Decode the optional attribution tail from encoded SpendingAuth or FreeUsage
 * metadata. Returns null when the metadata carries no tail; `invite` is null
 * when the tail carries none (zero r and vs).
 *
 * The tail grows the ABI head by exactly five words, so its presence shows in
 * the services-array offset: `(staticWords + 1) * 32` without a tail,
 * `(staticWords + 6) * 32` with one (the AntseedStatsV2 rule). Any other
 * shape, including the retired two-word referrer/clientId tail, reads as none.
 */
export function decodeMetadataAttribution(encoded: string): { clientId: string; invite: ReferralInvite | null } | null {
  const coder = AbiCoder.defaultAbiCoder();
  const [version] = coder.decode(['uint256'], encoded) as unknown as [bigint];
  // v3 metadata carries five static words (adds cumulativeOutputImages); v1/v2 carry four.
  const staticWords = version === METADATA_VERSION ? 5 : 4;
  const headWords = staticWords + 1 + ATTRIBUTION_TAIL_TYPES.length;
  // Head (with tail) plus the services length word.
  if ((encoded.length - 2) / 64 < headWords + 1) return null;
  const head = coder.decode(Array(headWords).fill('uint256'), encoded) as unknown as bigint[];
  if (head[staticWords] !== BigInt(headWords * 32)) return null;
  const word = (i: number) => toBeHex(head[staticWords + 1 + i]!, 32);
  const invite = { epoch: head[staticWords + 2]!, index: head[staticWords + 3]!, r: word(3), vs: word(4) };
  return {
    clientId: word(0),
    invite: invite.r === ZeroHash && invite.vs === ZeroHash ? null : invite,
  };
}

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  /** Optional so FreeUsageMetadata-shaped objects remain assignable; encodes as 0. */
  cumulativeOutputImages?: bigint;
  services?: SpendingAuthServiceMetadata[];
  /** Optional client / invite attribution tail; omitted when unset. */
  attribution?: UsageAttribution;
}

export interface SpendingAuthServiceMetadata {
  serviceId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeOutputImages: bigint;
}

export const METADATA_VERSION = 3n;

/**
 * Flat output-token equivalent credited per generated image in v3 metadata
 * (Gemini 2.5 Flash Image's published rate). Attribution only — never feeds
 * cost verification. Bound to METADATA_VERSION: changing it requires a bump.
 */
export const OUTPUT_IMAGE_TOKEN_EQUIVALENT = 1290n;

const SERVICE_METADATA_ABI_TYPE =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages)[]';

/** v2 service tuple, still used by FreeUsage metadata v1 (no image counter). */
const SERVICE_METADATA_ABI_TYPE_V2 =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]';

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
  const tail = attributionTailAbi(metadata.attribution);
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE, ...tail.types],
    [
      METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      metadata.cumulativeOutputImages ?? 0n,
      services,
      ...tail.values,
    ],
  );
}

export function getServiceMetadataId(service: string): string {
  return id(service.trim());
}

export interface ServiceMetadataDelta {
  amount: bigint;
  inputTokens: bigint;
  cachedInputTokens: bigint;
  outputTokens: bigint;
  requests: bigint;
  outputImages: bigint;
}

export function withServiceMetadata<T extends { services?: SpendingAuthServiceMetadata[] }>(
  metadata: T,
  service: string | undefined,
  delta: ServiceMetadataDelta,
): T {
  if (!service || service.trim().length === 0) return metadata;

  const serviceId = getServiceMetadataId(service);
  const byServiceId = new Map<string, SpendingAuthServiceMetadata>();
  for (const entry of metadata.services ?? []) {
    byServiceId.set(entry.serviceId, { ...entry });
  }

  const existing = byServiceId.get(serviceId) ?? {
    serviceId,
    cumulativeAmount: 0n,
    cumulativeInputTokens: 0n,
    cumulativeCachedInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 0n,
    cumulativeOutputImages: 0n,
  };

  byServiceId.set(serviceId, {
    serviceId,
    cumulativeAmount: existing.cumulativeAmount + delta.amount,
    cumulativeInputTokens: existing.cumulativeInputTokens + delta.inputTokens,
    cumulativeCachedInputTokens: existing.cumulativeCachedInputTokens + delta.cachedInputTokens,
    cumulativeOutputTokens: existing.cumulativeOutputTokens + delta.outputTokens,
    cumulativeRequestCount: existing.cumulativeRequestCount + delta.requests,
    cumulativeOutputImages: (existing.cumulativeOutputImages ?? 0n) + delta.outputImages,
  });

  return {
    ...metadata,
    services: [...byServiceId.values()].sort((a, b) =>
      a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
    ),
  };
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  cumulativeOutputImages: 0n,
  services: [],
};

export const ZERO_METADATA_HASH: string = computeMetadataHash(ZERO_METADATA);

/**
 * FreeUsage metadata v1.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     ServiceTotal[] services
 *   )
 *
 * Uses the v2 service tuple (no cumulativeOutputImages field — extra object
 * properties are ignored when encoding), so existing FreeUsage v1 decoders
 * keep working unchanged. cumulativeAmount is always zero for free usage.
 */
export interface FreeUsageMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  services?: SpendingAuthServiceMetadata[];
  /** Optional client / invite attribution tail; omitted when unset. */
  attribution?: UsageAttribution;
}

export type FreeUsageServiceMetadata = SpendingAuthServiceMetadata;

export const FREE_USAGE_METADATA_VERSION = 1n;

export function encodeFreeUsageMetadata(metadata: FreeUsageMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
  const tail = attributionTailAbi(metadata.attribution);
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE_V2, ...tail.types],
    [
      FREE_USAGE_METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      services,
      ...tail.values,
    ],
  );
}

export function computeFreeUsageMetadataHash(metadata: FreeUsageMetadata): string {
  return keccak256(encodeFreeUsageMetadata(metadata));
}

export const ZERO_FREE_USAGE_METADATA: FreeUsageMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  services: [],
};

export const ZERO_FREE_USAGE_METADATA_HASH: string = computeFreeUsageMetadataHash(ZERO_FREE_USAGE_METADATA);

// =========================================================================
// Channel ID computation (must match AntseedChannels.computeChannelId)
// =========================================================================

/**
 * Compute the deterministic channelId.
 * Must match: keccak256(abi.encode(buyer, seller, salt))
 */
export function computeChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['address', 'address', 'bytes32'],
    [buyer, seller, salt],
  ));
}

export const FREE_USAGE_CHANNEL_DOMAIN = id('ANTSEED_FREE_USAGE_CHANNEL');

/**
 * Compute the deterministic free usage channelId.
 * Domain-separated from AntseedChannels.computeChannelId so a paid and free
 * channel cannot share an ID even if buyer, seller, and salt are identical.
 */
export function computeFreeUsageChannelId(
  buyer: string,
  seller: string,
  salt: string,
): string {
  const coder = AbiCoder.defaultAbiCoder();
  return keccak256(coder.encode(
    ['bytes32', 'address', 'address', 'bytes32'],
    [FREE_USAGE_CHANNEL_DOMAIN, buyer, seller, salt],
  ));
}

// =========================================================================
// EIP-712 Domain helpers
// =========================================================================

export function makeChannelsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedChannels',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeDepositsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedDeposits',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeReferralsDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedReferrals',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

export function makeFreeUsageDomain(chainId: number, contractAddress: string): TypedDataDomain {
  return {
    name: 'AntseedFreeUsage',
    version: '1',
    chainId,
    verifyingContract: contractAddress,
  };
}

/**
 * EIP-712 domain of Circle's USDC (FiatTokenV2). Verified against the deployed
 * Base mainnet token (0x8335...2913): name "USD Coin", version "2". MockUSDC
 * on base-local mirrors the same params. Callers with RPC access should verify
 * via the token's DOMAIN_SEPARATOR() before first use (the params can differ
 * on other deployments).
 */
export function makeUsdcDomain(chainId: number, usdcAddress: string): TypedDataDomain {
  return {
    name: 'USD Coin',
    version: '2',
    chainId,
    verifyingContract: usdcAddress,
  };
}

// =========================================================================
// Signing functions — EIP-712 (on-chain)
// =========================================================================

export async function signSpendingAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SpendingAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, SPENDING_AUTH_TYPES, msg);
}

export async function signReserveAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: ReserveAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, RESERVE_AUTH_TYPES, msg);
}

export async function signSetOperator(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: SetOperatorMessage,
): Promise<string> {
  return signer.signTypedData(domain, SET_OPERATOR_TYPES, msg);
}

export async function signFreeUsageOpen(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: FreeUsageOpenMessage,
): Promise<string> {
  return signer.signTypedData(domain, FREE_USAGE_OPEN_TYPES, msg);
}

export async function signFreeUsageAuth(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  msg: FreeUsageAuthMessage,
): Promise<string> {
  return signer.signTypedData(domain, FREE_USAGE_AUTH_TYPES, msg);
}

export interface SignedReceiveAuthorization {
  message: ReceiveAuthorizationMessage;
  signature: string;
}

/**
 * Build and sign an EIP-3009 ReceiveWithAuthorization for USDC. Works with a
 * provider-less signer — the hot wallet never needs RPC access to sign.
 * A random 32-byte nonce is generated when none is supplied.
 */
export async function buildReceiveAuthorization(
  signer: AbstractSigner,
  domain: TypedDataDomain,
  params: {
    to: string;
    value: bigint;
    validAfter: bigint;
    validBefore: bigint;
    nonce?: string;
  },
): Promise<SignedReceiveAuthorization> {
  const message: ReceiveAuthorizationMessage = {
    from: await signer.getAddress(),
    to: params.to,
    value: params.value,
    validAfter: params.validAfter,
    validBefore: params.validBefore,
    nonce: params.nonce ?? hexlify(randomBytes(32)),
  };
  const signature = await signer.signTypedData(domain, RECEIVE_WITH_AUTHORIZATION_TYPES, message);
  return { message, signature };
}

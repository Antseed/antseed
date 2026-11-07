import { type AbstractSigner, type TypedDataDomain, AbiCoder, hexlify, id, keccak256, randomBytes } from 'ethers';

// =========================================================================
// EIP-712 Types — Antseed SpendingAuth (cumulative payment authorization)
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
 * SpendingAuth metadata v5.
 *
 * ABI layout:
 *   abi.encode(
 *     uint256 version,
 *     uint256 cumulativeInputTokens,
 *     uint256 cumulativeOutputTokens,
 *     uint256 cumulativeRequestCount,
 *     uint256 cumulativeOutputImages,
 *     uint256 cumulativeVideoGenerations,
 *     uint256 cumulativeVideoSeconds,
 *     uint256 cumulativeInputCharacters,
 *     ServiceTotal[] services
 *   )
 *
 * The first four fields intentionally match v1/v2 so legacy decoders can read
 * aggregate token/request counters by decoding only those fields. Service
 * entries are buyer-side attribution metadata for indexers: input tokens
 * include cached input, with cached input broken out separately. The service
 * tuple appends image, video and (v5) speech character counters after the v2
 * fields; decoders must switch on the leading version word before decoding the
 * rest (see decodeSpendingAuthMetadata). v4 is v5 without the character
 * counters.
 *
 * cumulativeInputCharacters counts the `input` characters of speech requests
 * whose audio was delivered; a failed speech request adds none.
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

export interface SpendingAuthMetadata {
  cumulativeInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  /** Optional so FreeUsageMetadata-shaped objects remain assignable; encodes as 0. */
  cumulativeOutputImages?: bigint;
  cumulativeVideoGenerations?: bigint;
  cumulativeVideoSeconds?: bigint;
  cumulativeInputCharacters?: bigint;
  services?: SpendingAuthServiceMetadata[];
}

export interface SpendingAuthServiceMetadata {
  serviceId: string;
  cumulativeAmount: bigint;
  cumulativeInputTokens: bigint;
  cumulativeCachedInputTokens: bigint;
  cumulativeOutputTokens: bigint;
  cumulativeRequestCount: bigint;
  cumulativeOutputImages: bigint;
  cumulativeVideoGenerations?: bigint;
  cumulativeVideoSeconds?: bigint;
  cumulativeInputCharacters?: bigint;
}

export const METADATA_VERSION = 5n;

/** The previous SpendingAuth metadata version: v5 without the speech character counters. */
export const METADATA_VERSION_V4 = 4n;

/**
 * Flat output-token equivalent credited per generated image in payment metadata
 * (Gemini 2.5 Flash Image's published rate). Attribution only — never feeds
 * cost verification. Bound to METADATA_VERSION: changing it requires a bump.
 */
export const OUTPUT_IMAGE_TOKEN_EQUIVALENT = 1290n;

const SERVICE_METADATA_ABI_TYPE =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages,uint256 cumulativeVideoGenerations,uint256 cumulativeVideoSeconds,uint256 cumulativeInputCharacters)[]';

/** v4 service tuple: v5 without cumulativeInputCharacters. */
const SERVICE_METADATA_ABI_TYPE_V4 =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount,uint256 cumulativeOutputImages,uint256 cumulativeVideoGenerations,uint256 cumulativeVideoSeconds)[]';

/** Top-level words before the services array, by version (the version word included). */
const METADATA_HEAD_WORDS: Record<string, number> = { '4': 7, '5': 8 };

/** v2 service tuple, still used by FreeUsage metadata v1 (no image counter). */
const SERVICE_METADATA_ABI_TYPE_V2 =
  'tuple(bytes32 serviceId,uint256 cumulativeAmount,uint256 cumulativeInputTokens,uint256 cumulativeCachedInputTokens,uint256 cumulativeOutputTokens,uint256 cumulativeRequestCount)[]';

export function encodeMetadata(metadata: SpendingAuthMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  ).map((service) => ({
    ...service,
    cumulativeVideoGenerations: service.cumulativeVideoGenerations ?? 0n,
    cumulativeVideoSeconds: service.cumulativeVideoSeconds ?? 0n,
    cumulativeInputCharacters: service.cumulativeInputCharacters ?? 0n,
  }));
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE],
    [
      METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      metadata.cumulativeOutputImages ?? 0n,
      metadata.cumulativeVideoGenerations ?? 0n,
      metadata.cumulativeVideoSeconds ?? 0n,
      metadata.cumulativeInputCharacters ?? 0n,
      services,
    ],
  );
}

export interface DecodedSpendingAuthMetadata extends Required<Omit<SpendingAuthMetadata, 'services'>> {
  version: bigint;
  services: Required<SpendingAuthServiceMetadata>[];
}

/**
 * Decode SpendingAuth metadata of version 4 or 5 (encodeMetadata's output and
 * the version before it). Counters a version does not carry decode as 0. Throws
 * on any other version or on bytes that do not match the version's layout.
 */
export function decodeSpendingAuthMetadata(encoded: string): DecodedSpendingAuthMetadata {
  const coder = AbiCoder.defaultAbiCoder();
  const [version] = coder.decode(['uint256'], encoded) as unknown as [bigint];
  const headWords = METADATA_HEAD_WORDS[version.toString()];
  if (headWords === undefined) throw new Error(`Unsupported SpendingAuth metadata version ${version}`);
  const v5 = version === METADATA_VERSION;
  const words = coder.decode(
    [...Array<string>(headWords).fill('uint256'), v5 ? SERVICE_METADATA_ABI_TYPE : SERVICE_METADATA_ABI_TYPE_V4],
    encoded,
  );
  const word = (index: number) => words[index] as bigint;
  const services = (words[headWords] as Array<Record<string, unknown>>).map((service) => ({
    serviceId: service.serviceId as string,
    cumulativeAmount: service.cumulativeAmount as bigint,
    cumulativeInputTokens: service.cumulativeInputTokens as bigint,
    cumulativeCachedInputTokens: service.cumulativeCachedInputTokens as bigint,
    cumulativeOutputTokens: service.cumulativeOutputTokens as bigint,
    cumulativeRequestCount: service.cumulativeRequestCount as bigint,
    cumulativeOutputImages: service.cumulativeOutputImages as bigint,
    cumulativeVideoGenerations: service.cumulativeVideoGenerations as bigint,
    cumulativeVideoSeconds: service.cumulativeVideoSeconds as bigint,
    cumulativeInputCharacters: v5 ? service.cumulativeInputCharacters as bigint : 0n,
  }));
  return {
    version,
    cumulativeInputTokens: word(1),
    cumulativeOutputTokens: word(2),
    cumulativeRequestCount: word(3),
    cumulativeOutputImages: word(4),
    cumulativeVideoGenerations: word(5),
    cumulativeVideoSeconds: word(6),
    cumulativeInputCharacters: v5 ? word(7) : 0n,
    services,
  };
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
  videoGenerations?: bigint;
  videoSeconds?: bigint;
  inputCharacters?: bigint;
}

/**
 * Most service entries one metadata blob carries. Every SpendingAuth repeats the
 * full metadata (twice when it carries a reserve batch), so an unbounded list
 * grows with each distinct service a channel uses until the payment frame
 * exceeds the 64 KiB payload limit and the seller drops every later auth.
 * 32 entries keep a batched SpendingAuth well under that limit.
 */
export const MAX_METADATA_SERVICES = 32;

/**
 * Service entry that collects usage of services beyond MAX_METADATA_SERVICES.
 * Attribution only: the aggregate counters still include every request.
 */
export const OTHER_SERVICES_METADATA_ID = id('antseed:other-services');

function addServiceTotals(
  target: SpendingAuthServiceMetadata,
  source: SpendingAuthServiceMetadata,
): SpendingAuthServiceMetadata {
  return {
    serviceId: target.serviceId,
    cumulativeAmount: target.cumulativeAmount + source.cumulativeAmount,
    cumulativeInputTokens: target.cumulativeInputTokens + source.cumulativeInputTokens,
    cumulativeCachedInputTokens: target.cumulativeCachedInputTokens + source.cumulativeCachedInputTokens,
    cumulativeOutputTokens: target.cumulativeOutputTokens + source.cumulativeOutputTokens,
    cumulativeRequestCount: target.cumulativeRequestCount + source.cumulativeRequestCount,
    cumulativeOutputImages: target.cumulativeOutputImages + source.cumulativeOutputImages,
    cumulativeVideoGenerations: (target.cumulativeVideoGenerations ?? 0n) + (source.cumulativeVideoGenerations ?? 0n),
    cumulativeVideoSeconds: (target.cumulativeVideoSeconds ?? 0n) + (source.cumulativeVideoSeconds ?? 0n),
    cumulativeInputCharacters: (target.cumulativeInputCharacters ?? 0n) + (source.cumulativeInputCharacters ?? 0n),
  };
}

function emptyServiceTotals(serviceId: string): SpendingAuthServiceMetadata {
  return {
    serviceId,
    cumulativeAmount: 0n,
    cumulativeInputTokens: 0n,
    cumulativeCachedInputTokens: 0n,
    cumulativeOutputTokens: 0n,
    cumulativeRequestCount: 0n,
    cumulativeOutputImages: 0n,
    cumulativeVideoGenerations: 0n,
    cumulativeVideoSeconds: 0n,
    cumulativeInputCharacters: 0n,
  };
}

function sortServices(services: Iterable<SpendingAuthServiceMetadata>): SpendingAuthServiceMetadata[] {
  return [...services].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
}

/**
 * Fold a service list that is longer than MAX_METADATA_SERVICES (metadata
 * persisted before the cap existed) into the largest services by amount plus
 * the OTHER_SERVICES_METADATA_ID entry. Lists within the cap are returned
 * unchanged, so this is a no-op once accumulation goes through
 * withServiceMetadata.
 */
export function boundServiceMetadata<T extends { services?: SpendingAuthServiceMetadata[] }>(metadata: T): T {
  const services = metadata.services ?? [];
  if (services.length <= MAX_METADATA_SERVICES) return metadata;

  let other = emptyServiceTotals(OTHER_SERVICES_METADATA_ID);
  const explicit: SpendingAuthServiceMetadata[] = [];
  for (const entry of services) {
    if (entry.serviceId === OTHER_SERVICES_METADATA_ID) other = addServiceTotals(other, entry);
    else explicit.push(entry);
  }
  explicit.sort((a, b) =>
    a.cumulativeAmount !== b.cumulativeAmount
      ? (a.cumulativeAmount > b.cumulativeAmount ? -1 : 1)
      : (a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0),
  );
  const kept = explicit.slice(0, MAX_METADATA_SERVICES - 1);
  for (const entry of explicit.slice(MAX_METADATA_SERVICES - 1)) other = addServiceTotals(other, entry);
  return { ...metadata, services: sortServices([...kept, other]) };
}

export function withServiceMetadata<T extends { services?: SpendingAuthServiceMetadata[] }>(
  metadata: T,
  service: string | undefined,
  delta: ServiceMetadataDelta,
): T {
  if (!service || service.trim().length === 0) return metadata;

  const byServiceId = new Map<string, SpendingAuthServiceMetadata>();
  for (const entry of boundServiceMetadata(metadata).services ?? []) {
    byServiceId.set(entry.serviceId, { ...entry });
  }
  let serviceId = getServiceMetadataId(service);
  const explicitCount = [...byServiceId.keys()].filter((key) => key !== OTHER_SERVICES_METADATA_ID).length;
  if (!byServiceId.has(serviceId) && explicitCount >= MAX_METADATA_SERVICES - 1) {
    // Services already listed keep their own entry (their totals only grow);
    // new ones past the cap share the overflow entry.
    serviceId = OTHER_SERVICES_METADATA_ID;
  }

  const existing = byServiceId.get(serviceId) ?? emptyServiceTotals(serviceId);

  byServiceId.set(serviceId, {
    serviceId,
    cumulativeAmount: existing.cumulativeAmount + delta.amount,
    cumulativeInputTokens: existing.cumulativeInputTokens + delta.inputTokens,
    cumulativeCachedInputTokens: existing.cumulativeCachedInputTokens + delta.cachedInputTokens,
    cumulativeOutputTokens: existing.cumulativeOutputTokens + delta.outputTokens,
    cumulativeRequestCount: existing.cumulativeRequestCount + delta.requests,
    cumulativeOutputImages: (existing.cumulativeOutputImages ?? 0n) + delta.outputImages,
    cumulativeVideoGenerations: (existing.cumulativeVideoGenerations ?? 0n) + (delta.videoGenerations ?? 0n),
    cumulativeVideoSeconds: (existing.cumulativeVideoSeconds ?? 0n) + (delta.videoSeconds ?? 0n),
    cumulativeInputCharacters: (existing.cumulativeInputCharacters ?? 0n) + (delta.inputCharacters ?? 0n),
  });

  return { ...metadata, services: sortServices(byServiceId.values()) };
}

export function computeMetadataHash(metadata: SpendingAuthMetadata): string {
  return keccak256(encodeMetadata(metadata));
}

export const ZERO_METADATA: SpendingAuthMetadata = {
  cumulativeInputTokens: 0n,
  cumulativeOutputTokens: 0n,
  cumulativeRequestCount: 0n,
  cumulativeOutputImages: 0n,
  cumulativeVideoGenerations: 0n,
  cumulativeVideoSeconds: 0n,
  cumulativeInputCharacters: 0n,
  services: [],
};

const ZERO_METADATA_ENCODED = encodeMetadata(ZERO_METADATA);

export const ZERO_METADATA_HASH: string = keccak256(ZERO_METADATA_ENCODED);

/** Zero metadata as v4 encodes it, still signed by buyers that have not upgraded. */
const ZERO_METADATA_V4_ENCODED = AbiCoder.defaultAbiCoder().encode(
  ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE_V4],
  [METADATA_VERSION_V4, 0n, 0n, 0n, 0n, 0n, 0n, []],
);

const ZERO_METADATA_BY_HASH = new Map([
  [ZERO_METADATA_HASH.toLowerCase(), ZERO_METADATA_ENCODED],
  [keccak256(ZERO_METADATA_V4_ENCODED).toLowerCase(), ZERO_METADATA_V4_ENCODED],
]);

/**
 * The zero metadata, in whichever accepted version (v5 or v4) `metadataHash`
 * is the hash of, or undefined. For a SpendingAuth sent without its metadata
 * bytes: the seller must settle with the exact bytes the buyer signed.
 */
export function zeroMetadataForHash(metadataHash: string): string | undefined {
  return ZERO_METADATA_BY_HASH.get(metadataHash.toLowerCase());
}

/** The metadata hash of the zero metadata in each accepted version (v5, then v4). */
export const ZERO_METADATA_HASHES: readonly string[] = [...ZERO_METADATA_BY_HASH.keys()];

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
}

export type FreeUsageServiceMetadata = SpendingAuthServiceMetadata;

export const FREE_USAGE_METADATA_VERSION = 1n;

export function encodeFreeUsageMetadata(metadata: FreeUsageMetadata): string {
  const coder = AbiCoder.defaultAbiCoder();
  const services = [...(metadata.services ?? [])].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
  return coder.encode(
    ['uint256', 'uint256', 'uint256', 'uint256', SERVICE_METADATA_ABI_TYPE_V2],
    [
      FREE_USAGE_METADATA_VERSION,
      metadata.cumulativeInputTokens,
      metadata.cumulativeOutputTokens,
      metadata.cumulativeRequestCount,
      services,
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

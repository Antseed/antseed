import {
  concat,
  decodeBase64,
  encodeBase64,
  getAddress,
  hexlify,
  isAddress,
  toBeHex,
  verifyTypedData,
  type TypedDataDomain,
  type TypedDataField,
} from 'ethers';

/**
 * A staker's consent to let one buyer use its seller-pool stake for staked
 * free-tier allowances. Signed with EIP-712 by the staker; the buyer sends it
 * to sellers in the `x-antseed-free-tier-delegations` request header.
 *
 * The signature names the buyer, so a seller only honours it on that buyer's
 * own authenticated connection: anyone who sees it cannot reuse it.
 */
export interface FreeTierDelegation {
  staker: string;
  buyer: string;
  /** Unix seconds after which the delegation no longer counts. */
  expiresAt: number;
  signature: string;
}

export const FREE_TIER_DELEGATIONS_HEADER = 'x-antseed-free-tier-delegations';
/** Most delegations a buyer sends and a seller honours per request. */
export const MAX_FREE_TIER_DELEGATIONS = 8;
/** Default lifetime offered when signing a delegation. */
export const DEFAULT_FREE_TIER_DELEGATION_DAYS = 90;

export const FREE_TIER_DELEGATION_TYPES: Record<string, TypedDataField[]> = {
  FreeTierDelegation: [
    { name: 'staker', type: 'address' },
    { name: 'buyer', type: 'address' },
    { name: 'expiresAt', type: 'uint64' },
  ],
};

export function makeFreeTierDelegationDomain(chainId: number): TypedDataDomain {
  return { name: 'AntseedFreeTier', version: '1', chainId };
}

/** The typed-data payload a staker's wallet signs. */
export function freeTierDelegationMessage(delegation: Omit<FreeTierDelegation, 'signature'>): Record<string, unknown> {
  return {
    staker: getAddress(delegation.staker),
    buyer: getAddress(delegation.buyer),
    expiresAt: delegation.expiresAt,
  };
}

/** Whether `delegation` is signed by its staker on `chainId`. Does not check expiry or the buyer. */
export function isFreeTierDelegationSigned(delegation: FreeTierDelegation, chainId: number): boolean {
  try {
    const recovered = verifyTypedData(
      makeFreeTierDelegationDomain(chainId),
      FREE_TIER_DELEGATION_TYPES,
      freeTierDelegationMessage(delegation),
      delegation.signature,
    );
    return recovered.toLowerCase() === delegation.staker.toLowerCase();
  } catch {
    return false;
  }
}

/** A delegation that passed signature checks: who staked, and until when it counts. */
export interface VerifiedFreeTierDelegation {
  staker: string;
  expiresAt: number;
}

/**
 * Delegations to `buyer` that are signed and unexpired, with lower-case
 * stakers, one per staker (latest expiry), at most `MAX_FREE_TIER_DELEGATIONS`.
 */
export function verifyFreeTierDelegations(
  delegations: readonly FreeTierDelegation[],
  buyer: string,
  chainId: number,
  nowMs = Date.now(),
): VerifiedFreeTierDelegation[] {
  const verified = new Map<string, number>();
  for (const delegation of delegations.slice(0, MAX_FREE_TIER_DELEGATIONS)) {
    if (delegation.buyer.toLowerCase() !== buyer.toLowerCase()) continue;
    if (delegation.expiresAt * 1000 <= nowMs) continue;
    if (!isFreeTierDelegationSigned(delegation, chainId)) continue;
    const staker = delegation.staker.toLowerCase();
    verified.set(staker, Math.max(verified.get(staker) ?? 0, delegation.expiresAt));
  }
  return [...verified].map(([staker, expiresAt]) => ({ staker, expiresAt }));
}

/**
 * Header value for `delegations`: comma-separated `staker:expiresAt:signature`.
 * The buyer is implied by the connection, so it is not sent.
 */
export function encodeFreeTierDelegationsHeader(delegations: readonly FreeTierDelegation[]): string {
  return delegations
    .slice(0, MAX_FREE_TIER_DELEGATIONS)
    .map((delegation) => `${delegation.staker.toLowerCase()}:${delegation.expiresAt}:${delegation.signature.toLowerCase()}`)
    .join(',');
}

/** Parse a header from `buyer`'s connection. Malformed entries are skipped. */
export function decodeFreeTierDelegationsHeader(value: string | undefined, buyer: string): FreeTierDelegation[] {
  if (!value) return [];
  const delegations: FreeTierDelegation[] = [];
  for (const entry of value.split(',').slice(0, MAX_FREE_TIER_DELEGATIONS)) {
    const [staker, expiresAt, signature] = entry.trim().split(':');
    if (!staker || !isAddress(staker) || !expiresAt || !/^\d{1,12}$/.test(expiresAt)) continue;
    if (!signature || !/^0x[0-9a-fA-F]{130}$/.test(signature)) continue;
    delegations.push({ staker, buyer, expiresAt: Number(expiresAt), signature });
  }
  return delegations;
}

/** Prefix of a shareable delegation code, so a pasted code is recognisable. */
export const FREE_TIER_DELEGATION_CODE_PREFIX = 'antseed-free-tier-';

/**
 * A copy-pasteable code for `delegation`, for a staker to hand to a buyer:
 * the prefix plus base64url of staker (20 bytes), buyer (20), expiresAt (u64)
 * and signature (65).
 */
export function encodeFreeTierDelegationCode(delegation: FreeTierDelegation): string {
  const bytes = concat([
    getAddress(delegation.staker),
    getAddress(delegation.buyer),
    toBeHex(delegation.expiresAt, 8),
    delegation.signature,
  ]);
  return FREE_TIER_DELEGATION_CODE_PREFIX + encodeBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Parse a code from `encodeFreeTierDelegationCode`. Throws on anything malformed; does not check the signature. */
export function decodeFreeTierDelegationCode(code: string): FreeTierDelegation {
  const trimmed = code.trim();
  if (!trimmed.startsWith(FREE_TIER_DELEGATION_CODE_PREFIX)) throw new Error('Not a free-tier code: it should start with ' + FREE_TIER_DELEGATION_CODE_PREFIX);
  const body = trimmed.slice(FREE_TIER_DELEGATION_CODE_PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(body)) throw new Error('Free-tier code is malformed');
  let bytes: Uint8Array;
  try {
    bytes = decodeBase64(body.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (body.length % 4)) % 4));
  } catch {
    throw new Error('Free-tier code is malformed');
  }
  if (bytes.length !== 113) throw new Error('Free-tier code is incomplete');
  return {
    staker: getAddress(hexlify(bytes.slice(0, 20))),
    buyer: getAddress(hexlify(bytes.slice(20, 40))),
    expiresAt: Number(BigInt(hexlify(bytes.slice(40, 48)))),
    signature: hexlify(bytes.slice(48)),
  };
}

/**
 * Decode a pasted code and check it is a usable delegation to `buyer` on
 * `chainId`. Throws an error a buyer can act on otherwise.
 */
export function acceptFreeTierDelegationCode(code: string, buyer: string, chainId: number, nowMs = Date.now()): FreeTierDelegation {
  const delegation = decodeFreeTierDelegationCode(code);
  if (delegation.buyer.toLowerCase() !== buyer.toLowerCase()) {
    throw new Error(`This code is for buyer ${delegation.buyer}, not ${getAddress(buyer)}. Ask the staker for a code for your buyer address.`);
  }
  if (delegation.expiresAt * 1000 <= nowMs) throw new Error('This code has expired. Ask the staker for a new one.');
  if (!isFreeTierDelegationSigned(delegation, chainId)) throw new Error('This code is not signed by its staker on this network.');
  return delegation;
}

/**
 * `delegations` with `delegation` added, replacing the same staker's earlier
 * delegation to the same buyer. Throws when that buyer already has the most.
 */
export function withFreeTierDelegation(delegations: readonly FreeTierDelegation[], delegation: FreeTierDelegation): FreeTierDelegation[] {
  const sameBuyer = (entry: FreeTierDelegation) => entry.buyer.toLowerCase() === delegation.buyer.toLowerCase();
  const kept = delegations.filter((entry) => !(sameBuyer(entry) && entry.staker.toLowerCase() === delegation.staker.toLowerCase()));
  if (kept.filter(sameBuyer).length >= MAX_FREE_TIER_DELEGATIONS) {
    throw new Error(`This buyer already has ${MAX_FREE_TIER_DELEGATIONS} stakers; remove one first.`);
  }
  return [...kept, delegation];
}

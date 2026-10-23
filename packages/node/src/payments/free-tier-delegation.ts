import { getAddress, isAddress, verifyTypedData, type TypedDataDomain, type TypedDataField } from 'ethers';

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

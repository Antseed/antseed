export const MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER = 0.5;
/** A service with a live on-chain DIFF verification verdict keeps 10% of its reputation. */
export const DIFF_VERIFICATION_REPUTATION_MULTIPLIER = 0.1;

export type ModelReputationSource = {
  /** Buyer-computed trust score (0-100). */
  onChainReputationScore?: number | null;
  /** Seller-reported score; only used when the buyer has not scored the peer. */
  reputationScore?: number | null;
};

export type VerificationDiffSource = {
  /** Services (verification keys) with a live DIFF verdict. See `verificationServiceKey`. */
  onChainDiffServices?: readonly string[] | null;
};

function finiteScore(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The buyer's trust score when available, otherwise the seller-reported score. */
export function normalizedModelReputationScore(source: ModelReputationSource): number | null {
  return finiteScore(source.onChainReputationScore) ?? finiteScore(source.reputationScore);
}

/**
 * The service name exactly as `AntseedKbfVerification` hashes it
 * (`keccak256(lowercase(trim(service)))`), so a verdict only ever matches the
 * service it was given for.
 */
export function verificationServiceKey(serviceId: string): string {
  return serviceId.trim().toLowerCase();
}

/** Whether the seller's offer of `serviceId` has a live on-chain DIFF verification verdict. */
export function hasLiveDiffVerdict(source: VerificationDiffSource | null | undefined, serviceId: string): boolean {
  const services = source?.onChainDiffServices;
  if (!Array.isArray(services) || services.length === 0) return false;
  const key = verificationServiceKey(serviceId);
  return key.length > 0 && services.includes(key);
}

/**
 * Apply model-specific adjustments to a normalized reputation:
 * - pricing completeness: a paid offer without a cached-input price, for a
 *   model other sellers price cache reads on, keeps half. Free offers are
 *   complete even when cached-input pricing is omitted.
 * - verification: an offer with a live DIFF verdict keeps 10%, free or not.
 * The multipliers compound. Missing reputation stays `null`.
 */
export function effectiveModelReputationScore(
  reputation: number | null,
  hasCachedInputPricing: boolean,
  modelHasCachedInputPricing: boolean,
  isFreeOffer = false,
  hasDiffVerdict = false,
): number | null {
  if (reputation === null) return null;
  let score = reputation;
  if (!isFreeOffer && modelHasCachedInputPricing && !hasCachedInputPricing) {
    score *= MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER;
  }
  if (hasDiffVerdict) score *= DIFF_VERIFICATION_REPUTATION_MULTIPLIER;
  return score;
}

export function compareEffectiveModelReputation(
  a: { effectiveReputationScore?: number | null; peerId: string },
  b: { effectiveReputationScore?: number | null; peerId: string },
): number {
  return (b.effectiveReputationScore ?? -1) - (a.effectiveReputationScore ?? -1)
    || a.peerId.localeCompare(b.peerId);
}

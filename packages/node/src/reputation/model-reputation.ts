export const MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER = 0.5;

export type ModelReputationSource = {
  /** Buyer-computed trust score (0-100). */
  onChainReputationScore?: number | null;
  /** Seller-reported score; only used when the buyer has not scored the peer. */
  reputationScore?: number | null;
};

function finiteScore(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The buyer's trust score when available, otherwise the seller-reported score. */
export function normalizedModelReputationScore(source: ModelReputationSource): number | null {
  return finiteScore(source.onChainReputationScore) ?? finiteScore(source.reputationScore);
}

/**
 * Apply model-specific pricing completeness to a normalized reputation.
 * Free offers are complete even when cached-input pricing is omitted.
 */
export function effectiveModelReputationScore(
  reputation: number | null,
  hasCachedInputPricing: boolean,
  modelHasCachedInputPricing: boolean,
  isFreeOffer = false,
): number | null {
  if (reputation === null || isFreeOffer) return reputation;
  return modelHasCachedInputPricing && !hasCachedInputPricing
    ? reputation * MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER
    : reputation;
}

export function compareEffectiveModelReputation(
  a: { effectiveReputationScore?: number | null; peerId: string },
  b: { effectiveReputationScore?: number | null; peerId: string },
): number {
  return (b.effectiveReputationScore ?? -1) - (a.effectiveReputationScore ?? -1)
    || a.peerId.localeCompare(b.peerId);
}

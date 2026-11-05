export const MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER = 0.5;
/** A service with a live on-chain DIFF verification verdict keeps 10% of its reputation. */
export const DIFF_VERIFICATION_REPUTATION_MULTIPLIER = 0.1;

export type ModelReputationSource = {
  /** Buyer-computed trust score (0-100). */
  onChainReputationScore?: number | null;
  /** Seller-reported score; only used when the buyer has not scored the peer. */
  reputationScore?: number | null;
};

/**
 * How long a verification read stays usable. The node reuses its last good
 * read for this long when the contract can't be read, and a DIFF list older
 * than this counts for nothing wherever it was carried or saved, so every
 * buyer surface fails open after the same 15 minutes.
 */
export const VERIFICATION_STATUS_STALE_MAX_MS = 15 * 60_000;

export type VerificationDiffSource = {
  /** Services (verification keys) with a live DIFF verdict. See `verificationServiceKey`. */
  onChainDiffServices?: readonly string[] | null;
  /** Services (verification keys) with a live SAME verdict. */
  onChainSameServices?: readonly string[] | null;
  /** Unix ms of the verification read behind `onChainDiffServices`; without it the list counts for nothing. */
  onChainVerificationFetchedAt?: number | null;
};

function finiteScore(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** The buyer's trust score when available, otherwise the seller-reported score. */
export function normalizedModelReputationScore(source: ModelReputationSource): number | null {
  return finiteScore(source.onChainReputationScore) ?? finiteScore(source.reputationScore);
}

/**
 * The service name exactly as `AntseedVerificationResults` hashes it
 * (`keccak256(lowercase(trim(service)))`), so a verdict only ever matches the
 * service it was given for.
 */
export function verificationServiceKey(serviceId: string): string {
  return serviceId.trim().toLowerCase();
}

/**
 * Whether the seller's offer of `serviceId` has a live on-chain DIFF
 * verification verdict, judged from a read at most
 * VERIFICATION_STATUS_STALE_MAX_MS old. A missing or older read fails open.
 */
export function hasLiveDiffVerdict(
  source: VerificationDiffSource | null | undefined,
  serviceId: string,
  nowMs: number = Date.now(),
): boolean {
  return hasLiveServiceVerdict(source?.onChainDiffServices, source?.onChainVerificationFetchedAt, serviceId, nowMs);
}

/** Whether `serviceId` is in a verdict list from a read at most VERIFICATION_STATUS_STALE_MAX_MS old. */
function hasLiveServiceVerdict(
  services: readonly string[] | null | undefined,
  fetchedAt: number | null | undefined,
  serviceId: string,
  nowMs: number,
): boolean {
  if (!Array.isArray(services) || services.length === 0) return false;
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) return false;
  if (nowMs - fetchedAt >= VERIFICATION_STATUS_STALE_MAX_MS) return false;
  const key = verificationServiceKey(serviceId);
  return key.length > 0 && services.includes(key);
}

/**
 * Whether the seller's offer of `serviceId` has a live on-chain SAME
 * verification verdict, under the same freshness rule as `hasLiveDiffVerdict`.
 */
export function hasLiveSameVerdict(
  source: VerificationDiffSource | null | undefined,
  serviceId: string,
  nowMs: number = Date.now(),
): boolean {
  return hasLiveServiceVerdict(source?.onChainSameServices, source?.onChainVerificationFetchedAt, serviceId, nowMs);
}

/** The live verification verdict of one offer: 'diff', 'same' or null when there is none or the read is stale. */
export function liveVerificationVerdict(
  source: VerificationDiffSource | null | undefined,
  serviceId: string,
  nowMs: number = Date.now(),
): 'diff' | 'same' | null {
  if (hasLiveDiffVerdict(source, serviceId, nowMs)) return 'diff';
  if (hasLiveSameVerdict(source, serviceId, nowMs)) return 'same';
  return null;
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

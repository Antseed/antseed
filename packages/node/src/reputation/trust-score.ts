import type { PeerInfo } from '../types/peer.js';
import { VERIFICATION_POINTS_BPS } from './verification-points.js';
import { VERIFICATION_STATUS_STALE_MAX_MS } from './model-reputation.js';
import { IDENTITY_GITHUB_MAX_POINTS as IDENTITY_MAX_POINTS, scoreIdentityHistory } from './identity-history.js';

/**
 * Buyer-side trust score, 0-100. It estimates what a buyer's spend with a seller
 * earns (stake behind the seller, scaled by the points policies) and whether the
 * seller carries real volume, plus credit for a proven identity and a free model:
 *
 *   sum   = min(100, power + usage + identity + freeModels)
 *   trust = washFlagged ? 0 : min(100, sum * verification multiplier)
 *
 * - power (70):    the pool's share of all pools' lock-weighted staking power in
 *                  the current epoch (`AntseedSellerPools`): what a buyer's spend
 *                  with this seller earns this week.
 * - usage (30):    the seller pool's share of all pools' recognized-usage points
 *                  in the last complete weekly epoch (`AntseedUsageAccounting`).
 *                  Points only accrue for sellers with a pool and already pass
 *                  the on-chain points policies.
 * - identity (+20): public history of a verified identity (GitHub portfolio or
 *                  domain registration age, see `identity-history.ts`).
 * - freeModels (+5): when the seller offers at least one model at $0 input and
 *                  output (and cached input, when it prices one).
 * - verification:  the seller's points multiplier from the verification policy,
 *                  both its bonus and its penalty: what the same spend earns.
 * - wash:          a seller flagged by `AntseedWashTradingRegistry` scores 0.
 *
 * Shares are unitless and self-normalizing, mapped through `shareCurve`, a log
 * curve with a 1000x range that gives full marks at `TRUST_FULL_SHARE_BPS`
 * (50% -> 1, 5% -> 0.67, 0.5% -> 0.35). Settled service history is reported for
 * display and does not change the number.
 *
 * Failure streaks, cooldowns, price limits and allow/block lists stay separate
 * router rules.
 */

/** Most a verified identity adds on top of the weights; the total caps at 100. */
export const TRUST_IDENTITY_BONUS = 20;

/** Maximum contribution of each part. `usage` and `power`, the two network shares, sum to 100. */
export const TRUST_WEIGHTS = {
  usage: 30,
  power: 70,
  /** @deprecated Service history no longer feeds the score. */
  history: 0,
  /** @deprecated Use `TRUST_IDENTITY_BONUS`. */
  identity: TRUST_IDENTITY_BONUS,
} as const;

/** Bonus for offering a free model, added on top of the weights; the total caps at 100. */
export const TRUST_FREE_MODELS_BONUS = 5;

/** The network share that earns full marks in `shareCurve`, in basis points. */
export const TRUST_FULL_SHARE_BPS = 5_000;

/** @deprecated Service history no longer feeds the trust score. */
export const TRUST_HISTORY_CHANNEL_TARGET = 100;

/** @deprecated Service history no longer feeds the trust score. */
export const TRUST_HISTORY_VOLUME_USDC_MICROS_TARGET = 100_000_000;

/** Dynamic range of the share curve: a share of 1/SHARE_CURVE_RANGE maps to ~0. */
export const SHARE_CURVE_RANGE = 1_000;

export interface TrustBreakdown {
  /** Final trust score, 0-100. */
  score: number;
  /** Settled service history, for display only; `null` when channel stats are unavailable. */
  history: {
    /** @deprecated Always 0: service history no longer feeds the score. */
    score: number;
    channelCount: number;
    totalVolumeUsdcMicros: number;
  } | null;
  /** Last epoch's usage-points share, weighted 0-30; `null` when usage accounting data is unavailable. */
  usage: { score: number; shareBps: number; epoch: number } | null;
  /** Current epoch's staking-power share, weighted 0-70; `null` when pool data is unavailable. */
  power: { score: number; shareBps: number; epoch: number } | null;
  /** Verified-identity bonus, 0-20; `null` when no verified identity has usable history. */
  identity: { score: number; kind: 'github' | 'domain'; claim: string } | null;
  /** Free-model bonus, +5; `null` when the seller announces no free model. */
  freeModels: { score: number; service: string } | null;
  /** Wash-trading registry verdict; `null` when the registry is unavailable. */
  washFlagged: boolean | null;
  /**
   * Model-verification effect: the seller's points multiplier from the verification policy and
   * the points it added (positive) or took off (negative).
   * `null` when it changes nothing or there is no fresh verification read.
   */
  verification?: {
    multiplierBps: number;
    sameCount: number;
    diffCount: number;
    change: number;
    /** @deprecated Use `change`. The points taken off, 0 for a bonus. */
    penalty: number;
  } | null;
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * `log10(1 + (SHARE_CURVE_RANGE - 1) · min(1, share / full)) / log10(SHARE_CURVE_RANGE)` in 0-1, share in
 * basis points and `full` being `TRUST_FULL_SHARE_BPS`.
 */
export function shareCurve(shareBps: number): number {
  if (!Number.isFinite(shareBps) || shareBps <= 0) return 0;
  const share = Math.min(1, shareBps / TRUST_FULL_SHARE_BPS);
  return Math.log10(1 + (SHARE_CURVE_RANGE - 1) * share) / Math.log10(SHARE_CURVE_RANGE);
}

function isFreePrice(price: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number } | undefined): boolean {
  return price?.inputUsdPerMillion === 0
    && price.outputUsdPerMillion === 0
    && (price.cachedInputUsdPerMillion === undefined || price.cachedInputUsdPerMillion === 0);
}

/** The first announced model priced at $0, or `null` when the seller offers none. */
export function firstFreeService(peer: PeerInfo): string | null {
  for (const [provider, entry] of Object.entries(peer.providerPricing ?? {})) {
    const services = entry.services ?? {};
    for (const [service, price] of Object.entries(services)) {
      if (isFreePrice({ ...entry.defaults, ...price })) return service;
    }
    if (Object.keys(services).length === 0 && isFreePrice(entry.defaults)) return provider;
  }
  return null;
}

/**
 * Bounded logarithmic progress toward a non-zero target.
 * @deprecated Service history no longer feeds the trust score.
 */
export function historyCurve(value: number, target: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(target) || target <= 0) return 0;
  return Math.min(1, Math.log10(1 + value) / Math.log10(1 + target));
}

/**
 * Compute the trust breakdown, or `null` when nothing about the peer is known
 * (no pool/usage read, no verified identity history, no registry read). A free
 * model alone does not make an unknown seller scored.
 */
export function computeTrustScore(peer: PeerInfo, nowMs = Date.now()): TrustBreakdown | null {
  const channelCount = finite(peer.onChainChannelCount);
  const totalVolumeUsdcMicros = finite(peer.onChainTotalVolumeUsdcMicros);
  const history = channelCount !== null && totalVolumeUsdcMicros !== null
    ? { score: 0, channelCount, totalVolumeUsdcMicros }
    : null;

  const epoch = finite(peer.onChainUsageEpoch);
  const usageShare = finite(peer.onChainUsageShareBps);
  const usage = epoch !== null && usageShare !== null && epoch > 0
    ? { score: TRUST_WEIGHTS.usage * shareCurve(usageShare), shareBps: usageShare, epoch: epoch - 1 }
    : null;

  const powerShare = finite(peer.onChainPoolPowerShareBps);
  const power = epoch !== null && powerShare !== null
    ? { score: TRUST_WEIGHTS.power * shareCurve(powerShare), shareBps: powerShare, epoch }
    : null;

  const identityHistory = scoreIdentityHistory(peer, nowMs);
  const identity = identityHistory
    ? { score: TRUST_IDENTITY_BONUS * identityHistory.points / IDENTITY_MAX_POINTS, kind: identityHistory.kind, claim: identityHistory.claim }
    : null;

  const freeService = firstFreeService(peer);
  const freeModels = freeService !== null ? { score: TRUST_FREE_MODELS_BONUS, service: freeService } : null;

  const washFlagged = typeof peer.onChainWashFlagged === 'boolean' ? peer.onChainWashFlagged : null;

  if (history === null && usage === null && power === null && identity === null && washFlagged === null) return null;

  const sum = washFlagged ? 0 : Math.min(100,
    (usage?.score ?? 0) + (power?.score ?? 0) + (identity?.score ?? 0) + (freeModels?.score ?? 0));
  const multiplierBps = verificationMultiplierBps(peer, nowMs);
  const score = multiplierBps === null ? sum : Math.min(100, sum * multiplierBps / VERIFICATION_POINTS_BPS);
  const verification = multiplierBps === null || score === sum ? null : {
    multiplierBps,
    sameCount: peer.onChainVerificationStatus!.sameCount,
    diffCount: peer.onChainVerificationStatus!.diffCount,
    change: score - sum,
    penalty: Math.max(0, sum - score),
  };
  return { score, history, usage, power, identity, freeModels, washFlagged, verification };
}

/**
 * The seller's verification points multiplier from a read at most VERIFICATION_STATUS_STALE_MAX_MS
 * old; null otherwise, so stale reads fail open.
 */
function verificationMultiplierBps(peer: PeerInfo, nowMs: number): number | null {
  const multiplier = peer.onChainVerificationStatus?.pointsMultiplierBps;
  const fetchedAt = peer.onChainVerificationFetchedAt;
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier)) return null;
  if (typeof fetchedAt !== 'number' || nowMs - fetchedAt >= VERIFICATION_STATUS_STALE_MAX_MS) return null;
  return Math.max(0, multiplier);
}

/** Trust score alone, or `null` when the peer is unscored. */
export function trustScore(peer: PeerInfo, nowMs = Date.now()): number | null {
  return computeTrustScore(peer, nowMs)?.score ?? null;
}

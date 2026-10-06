import type { PeerInfo } from '../types/peer.js';
import { IDENTITY_GITHUB_MAX_POINTS as IDENTITY_MAX_POINTS, scoreIdentityHistory } from './identity-history.js';

/**
 * Buyer-side trust score, 0-100: a weighted sum of independent parts.
 *
 *   trust = washFlagged ? 0 : history + usage + power + identity
 *
 * Each part is a 0-1 value times its weight from `TRUST_WEIGHTS`:
 *
 * - history (50):  settled service history from `AntseedChannels`, combining
 *                  channel count and USDC volume on bounded log curves.
 * - usage (20):    the seller pool's share of all pools' recognized-usage points
 *                  in the last complete weekly epoch (`AntseedUsageAccounting`).
 *                  Points only accrue for sellers with a pool and already pass
 *                  the on-chain points policies.
 * - power (10):    the pool's share of all pools' lock-weighted staking power in
 *                  the current epoch (`AntseedSellerPools`): what a buyer's spend
 *                  with this seller earns this week.
 * - identity (20): public history of a verified identity (GitHub portfolio or
 *                  domain registration age, see `identity-history.ts`).
 * - wash:          a seller flagged by `AntseedWashTradingRegistry` scores 0.
 *
 * Shares are unitless and self-normalizing, mapped through `shareCurve`, a log
 * curve with a 1000x range (100% → 1, 10% → 0.67, 1% → 0.35). Weights sum to
 * 100; a future model-verification (KBF) part takes its share from this table.
 *
 * Nothing else feeds the number. Failure streaks, cooldowns, price limits and
 * allow/block lists stay separate router rules.
 */

/** Maximum contribution of each part; the weights sum to 100. */
export const TRUST_WEIGHTS = { history: 50, usage: 20, power: 10, identity: 20 } as const;

/** Settled sessions needed to saturate the channel-count half of service history. */
export const TRUST_HISTORY_CHANNEL_TARGET = 100;

/** Settled volume needed to saturate the volume half of service history. */
export const TRUST_HISTORY_VOLUME_USDC_MICROS_TARGET = 100_000_000;

/** Dynamic range of the share curve: a share of 1/SHARE_CURVE_RANGE maps to ~0. */
export const SHARE_CURVE_RANGE = 1_000;

export interface TrustBreakdown {
  /** Final trust score, 0-100. */
  score: number;
  /** Settled service history, weighted 0-50; `null` when channel stats are unavailable. */
  history: { score: number; channelCount: number; totalVolumeUsdcMicros: number } | null;
  /** Last epoch's usage-points share, weighted 0-20; `null` when usage accounting data is unavailable. */
  usage: { score: number; shareBps: number; epoch: number } | null;
  /** Current epoch's staking-power share, weighted 0-10; `null` when pool data is unavailable. */
  power: { score: number; shareBps: number; epoch: number } | null;
  /** Verified-identity part, weighted 0-20; `null` when no verified identity has usable history. */
  identity: { score: number; kind: 'github' | 'domain'; claim: string } | null;
  /** Wash-trading registry verdict; `null` when the registry is unavailable. */
  washFlagged: boolean | null;
}

function finite(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** `log10(1 + (SHARE_CURVE_RANGE - 1) · share) / log10(SHARE_CURVE_RANGE)` in 0-1, share in basis points. */
export function shareCurve(shareBps: number): number {
  if (!Number.isFinite(shareBps) || shareBps <= 0) return 0;
  const share = Math.min(1, shareBps / 10_000);
  return Math.log10(1 + (SHARE_CURVE_RANGE - 1) * share) / Math.log10(SHARE_CURVE_RANGE);
}

/** Bounded logarithmic progress toward a non-zero service-history target. */
export function historyCurve(value: number, target: number): number {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(target) || target <= 0) return 0;
  return Math.min(1, Math.log10(1 + value) / Math.log10(1 + target));
}

/**
 * Compute the trust breakdown, or `null` when nothing about the peer is known
 * (no pool/usage read, no verified identity history, no registry read).
 */
export function computeTrustScore(peer: PeerInfo, nowMs = Date.now()): TrustBreakdown | null {
  const channelCount = finite(peer.onChainChannelCount);
  const totalVolumeUsdcMicros = finite(peer.onChainTotalVolumeUsdcMicros);
  const history = channelCount !== null && totalVolumeUsdcMicros !== null
    ? {
        score: TRUST_WEIGHTS.history * (
          historyCurve(channelCount, TRUST_HISTORY_CHANNEL_TARGET)
          + historyCurve(
            totalVolumeUsdcMicros / 1_000_000,
            TRUST_HISTORY_VOLUME_USDC_MICROS_TARGET / 1_000_000,
          )
        ) / 2,
        channelCount,
        totalVolumeUsdcMicros,
      }
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
    ? { score: TRUST_WEIGHTS.identity * identityHistory.points / IDENTITY_MAX_POINTS, kind: identityHistory.kind, claim: identityHistory.claim }
    : null;

  const washFlagged = typeof peer.onChainWashFlagged === 'boolean' ? peer.onChainWashFlagged : null;

  if (history === null && usage === null && power === null && identity === null && washFlagged === null) return null;

  const score = washFlagged ? 0 : Math.min(100,
    (history?.score ?? 0) + (usage?.score ?? 0) + (power?.score ?? 0) + (identity?.score ?? 0));
  return { score, history, usage, power, identity, washFlagged };
}

/** Trust score alone, or `null` when the peer is unscored. */
export function trustScore(peer: PeerInfo, nowMs = Date.now()): number | null {
  return computeTrustScore(peer, nowMs)?.score ?? null;
}

// Points math for Antseed Points. Pure functions, no I/O.
//
// Nothing here is a new rewards system: it re-expresses what the usage
// contracts already record. On-chain, every settlement stores
//   weightedPoints = USDC spent (6 decimals) × provider pool power (wei ANTS·epochs)
// and each epoch's pot is split pro rata by weighted points, with any single
// buyer or provider claim capped at 5% of the pot
// (AntseedUsageRewards.MAX_REWARD_SHARE_BPS = 500). "Points" are those weighted
// points divided by a fixed reference power, so every number converts to
// exactly the ANTS the contracts pay.

export const GENESIS_MS = Date.parse('2026-04-09T09:54:21Z');
export const EPOCH_MS = 7 * 86_400_000;
export const MAX_LOCK_EPOCHS = 104;
/** 1.0× boost = 10,000 ANTS locked for the full 104 epochs. */
export const REFERENCE_POWER = 10_000 * MAX_LOCK_EPOCHS; // ANTS·epochs
export const CLAIM_CAP_BPS = 500;
export const MIN_SLASH = 0.05;
export const MAX_SLASH = 0.5;

export const epochAt = (ms: number) => Math.floor((ms - GENESIS_MS) / EPOCH_MS);
export const epochStartMs = (epoch: number) => GENESIS_MS + epoch * EPOCH_MS;
export const epochEndMs = (epoch: number) => epochStartMs(epoch + 1);

/** bigint-ish (string | bigint) scaled by 10^decimals → float. Safe for 1e40-range values. */
export function scaled(value: string | bigint | null | undefined, decimals: number): number {
  if (value === null || value === undefined || value === '') return 0;
  let v: bigint;
  try {
    v = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return 0;
  }
  // A double keeps ~16 significant digits at any magnitude, which is plenty
  // for display and for pro-rata shares.
  return Number(v) / 10 ** decimals;
}

export const antsFromWei = (wei: string | bigint | null | undefined) => scaled(wei, 18);
export const usdFromUsdc = (units: string | bigint | null | undefined) => scaled(units, 6);

/** Pool power (wei ANTS·epochs, e.g. Antscan `weight` or poolWeightAtEpoch) → boost. */
export function boostFromWeight(weight: string | bigint | null | undefined): number {
  return antsFromWei(weight) / REFERENCE_POWER;
}

/** On-chain weighted points (USDC 1e6 × power 1e18) → Antseed points. */
export function pointsFromWeighted(weighted: string | bigint | null | undefined): number {
  return scaled(weighted, 24) / REFERENCE_POWER;
}

/** ANTS one point is worth for a given pot and total weighted points (final once the epoch ends). */
export function antsPerPoint(potAnts: number, totalWeighted: string | bigint | null | undefined): number {
  const total = pointsFromWeighted(totalWeighted);
  return total > 0 ? potAnts / total : 0;
}

export interface UsageRewardEstimate {
  /** Pro-rata share before the cap. */
  gross: number;
  /** What the contract would actually pay. */
  ants: number;
  capped: boolean;
}

/** One buyer's (or one provider's) share of an epoch pot, with the 5% per-claim cap applied. */
export function usageReward(
  potAnts: number,
  myWeighted: string | bigint | null | undefined,
  totalWeighted: string | bigint | null | undefined,
): UsageRewardEstimate {
  const mine = scaled(myWeighted, 24);
  const total = scaled(totalWeighted, 24);
  const gross = total > 0 ? (potAnts * mine) / total : 0;
  const cap = (potAnts * CLAIM_CAP_BPS) / 10_000;
  return { gross, ants: Math.min(gross, cap), capped: gross > cap };
}

/**
 * What a buyer would earn by spending `spendUsd` this epoch with a provider of
 * the given boost. Their own points join the total, so the pro-rata share is
 * pot × p / (total + p), then capped at 5% of the pot like the contract does.
 */
export function earnEstimate(
  potAnts: number,
  totalWeighted: string | bigint | null | undefined,
  spendUsd: number,
  boost: number,
): { points: number; ants: number; capped: boolean } {
  const points = Math.max(0, spendUsd) * Math.max(0, boost);
  const total = pointsFromWeighted(totalWeighted);
  const gross = points > 0 ? (potAnts * points) / (total + points) : 0;
  const cap = (potAnts * CLAIM_CAP_BPS) / 10_000;
  return { points, ants: Math.min(gross, cap), capped: gross > cap };
}

/**
 * Weekly staker estimate for adding `stakeAnts` locked for `lockEpochs` behind a
 * provider. The staker pot is split by pool weighted points (provider volume ×
 * pool power) and then inside the pool by position power, so a new position
 * earns stakerPot × volume × myPower / (totalWeighted + volume × myPower).
 * Uses this epoch's volume and pot; not capped on-chain.
 */
export function stakerEstimate(opts: {
  stakerPotAnts: number;
  providerVolumeUsd: number;
  stakeAnts: number;
  lockEpochs: number;
  totalPoolWeighted: string | bigint | null | undefined;
}): number {
  const myPower = opts.stakeAnts * Math.min(Math.max(opts.lockEpochs, 0), MAX_LOCK_EPOCHS);
  const add = opts.providerVolumeUsd * myPower;
  const total = scaled(opts.totalPoolWeighted, 24) + add;
  return total > 0 ? (opts.stakerPotAnts * add) / total : 0;
}

/**
 * The staker estimate, steadied early in the week. Right after Thursday's reset only a few
 * providers have any spend, so this week's split swings wildly; we blend in last week's
 * split and lean on this week's more as the week goes on (`weekFraction` 0 → 1).
 */
export function blendedStakerEstimate(opts: {
  stakerPotAnts: number;
  stakeAnts: number;
  lockEpochs: number;
  volumeUsd: number;
  totalPoolWeighted: string | bigint | null | undefined;
  lastVolumeUsd: number;
  lastTotalPoolWeighted: string | bigint | null | undefined;
  weekFraction: number;
}): number {
  const base = { stakerPotAnts: opts.stakerPotAnts, stakeAnts: opts.stakeAnts, lockEpochs: opts.lockEpochs };
  const now = stakerEstimate({ ...base, providerVolumeUsd: opts.volumeUsd, totalPoolWeighted: opts.totalPoolWeighted });
  if (scaled(opts.lastTotalPoolWeighted, 24) <= 0) return now;
  const last = stakerEstimate({ ...base, providerVolumeUsd: opts.lastVolumeUsd, totalPoolWeighted: opts.lastTotalPoolWeighted });
  const f = Math.min(1, Math.max(0, opts.weekFraction));
  return f * now + (1 - f) * last;
}

/** Early-exit burn as a fraction of principal: max(5%, min(50%, 50% × remaining / total)), 0 once the lock ends. */
export function slashFraction(remainingEpochs: number, totalEpochs: number): number {
  if (remainingEpochs <= 0 || totalEpochs <= 0) return 0;
  return Math.max(MIN_SLASH, Math.min(MAX_SLASH, (MAX_SLASH * remainingEpochs) / totalEpochs));
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export interface EarnRange {
  /** If nobody else spends from now on: today's estimate, and the most this can be worth. */
  now: number;
  /** If the rest of the week keeps this week's pace so far. */
  expected: number;
  /** If the rest of the week runs at the busiest recent pace. */
  low: number;
  capped: boolean;
}

const DAY_MS = 86_400_000;

/**
 * A likely range for what points will be worth when the week closes. ANTS =
 * pot × mine / everyone's points at close; the unknown is how many points
 * others add before Thursday, so project that from the pace so far (expected)
 * and from the busiest recent pace (low). The rate only falls during a week,
 * so `now` is a ceiling. `alreadyCounted` is true for points already earned
 * (they're inside `totalPoints`) and false for a what-if spend.
 */
export function projectRange(opts: {
  potAnts: number;
  totalPoints: number;
  myPoints: number;
  alreadyCounted: boolean;
  elapsedMs: number;
  leftMs: number;
  /** Everyone's points per day on a busy day (busiest recent day's $ × this week's average boost). */
  busyPointsPerDay: number;
}): EarnRange {
  const { potAnts, totalPoints, myPoints, alreadyCounted } = opts;
  const mine = Math.max(0, myPoints);
  const others = Math.max(0, alreadyCounted ? totalPoints - mine : totalPoints);
  const cap = (potAnts * CLAIM_CAP_BPS) / 10_000;
  const share = (othersAtClose: number) => (mine > 0 ? Math.min(cap, (potAnts * mine) / (othersAtClose + mine)) : 0);
  const leftDays = Math.max(0, opts.leftMs) / DAY_MS;
  // Too early in the week to trust our own pace: fall back to the busy pace.
  const elapsedDays = Math.max(0, opts.elapsedMs) / DAY_MS;
  const pace = elapsedDays >= 1 / 24 ? totalPoints / elapsedDays : opts.busyPointsPerDay;
  const busy = Math.max(opts.busyPointsPerDay, pace * 1.5);
  const now = share(others);
  return {
    now,
    expected: share(others + pace * leftDays),
    low: share(others + busy * leftDays),
    capped: mine > 0 && (potAnts * mine) / (others + mine) > cap,
  };
}

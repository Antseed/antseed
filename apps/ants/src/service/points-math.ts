/**
 * Antseed Points math. Pure and dependency-free (also published as
 * `@antseed/ants/points` for browser apps).
 *
 * Nothing here is a new rewards system: it re-expresses what the usage
 * contracts already record. Every settlement stores
 *   weightedPoints = USDC spent (6 decimals) × provider pool power (wei ANTS·epochs)
 * and each epoch's pot is split pro rata by weighted points, with any single
 * buyer or provider claim capped at 5% of the pot
 * (AntseedUsageRewards.MAX_REWARD_SHARE_BPS = 500). "Points" are those weighted
 * points divided by a fixed reference power (1.0× = 10,000 ANTS locked for 104
 * epochs), so $1 with a 1× provider is 1 point.
 */

export const MAX_LOCK_EPOCHS = 104;
/** The 1.0× reference, in ANTS·epochs. */
export const REFERENCE_POWER_ANTS = 10_000 * MAX_LOCK_EPOCHS;
/** AntseedUsageRewards.MAX_REWARD_SHARE_BPS: one claim takes at most 5% of an epoch's pot. */
export const CLAIM_CAP_BPS = 500;

/** A decimal integer (string or bigint) scaled down by 10^decimals; 0 for anything unparsable. */
export function scaled(value: string | bigint | null | undefined, decimals: number): number {
  if (value === null || value === undefined || value === '') return 0;
  let v: bigint;
  try {
    v = typeof value === 'bigint' ? value : BigInt(value);
  } catch {
    return 0;
  }
  // A double keeps ~16 significant digits at any magnitude: plenty for display and pro-rata shares.
  return Number(v) / 10 ** decimals;
}

export const antsFromWei = (wei: string | bigint | null | undefined): number => scaled(wei, 18);

/** On-chain weighted points (USDC 1e6 × power 1e18) → Antseed points. */
export function pointsFromWeighted(weighted: string | bigint | null | undefined): number {
  return scaled(weighted, 24) / REFERENCE_POWER_ANTS;
}

/** ANTS one point is worth for a pot and the epoch's total weighted points (final once the epoch ends). */
export function antsPerPoint(potAnts: number, totalWeighted: string | bigint | null | undefined): number {
  const total = pointsFromWeighted(totalWeighted);
  return total > 0 ? potAnts / total : 0;
}

export interface UsageRewardEstimate {
  /** Pro-rata share before the cap. */
  gross: number;
  /** What the contract would pay. */
  ants: number;
  capped: boolean;
}

/** One buyer's (or provider's) share of an epoch pot, with the 5% per-claim cap applied. */
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

export interface SpendEstimate {
  /** Points the extra spend adds: $ × boost. */
  addedPoints: number;
  /** The buyer's points for the epoch, the extra spend included. */
  points: number;
  /** The buyer's ANTS for the epoch at the live rate, with the 5% cap. */
  ants: number;
  capped: boolean;
}

/**
 * What a buyer ends the epoch with if they spend `spendUsd` more with a
 * provider of the given boost. Their new points join everyone's, so the share
 * is pot × (mine + added) / (total + added), then capped at 5% of the pot like
 * the contract. `totalPoints` already includes `myPoints`. Free usage earns no
 * points, so pass boost 0 for a free provider.
 */
export function spendEstimate(opts: { potAnts: number; totalPoints: number; myPoints: number; spendUsd: number; boost: number }): SpendEstimate {
  const addedPoints = Math.max(0, opts.spendUsd) * Math.max(0, opts.boost);
  const points = Math.max(0, opts.myPoints) + addedPoints;
  const total = Math.max(opts.totalPoints, opts.myPoints) + addedPoints;
  const gross = total > 0 ? (opts.potAnts * points) / total : 0;
  const cap = (opts.potAnts * CLAIM_CAP_BPS) / 10_000;
  return { addedPoints, points, ants: Math.min(gross, cap), capped: gross > cap };
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
 * A likely range for what points will be worth when the epoch closes (the
 * Points site's projection). ANTS = pot × mine / everyone's points at close;
 * the unknown is how many points others add before then, projected from the
 * pace so far (expected) and from the busiest recent pace (low). The rate only
 * falls during an epoch, so `now` is a ceiling. `alreadyCounted` is true when
 * `myPoints` are inside `totalPoints`, false for a what-if spend.
 * `pacePoints` (default `totalPoints`) is what the pace so far is measured from,
 * so a what-if spend added to `totalPoints` does not inflate it.
 */
export function projectRange(opts: {
  potAnts: number;
  totalPoints: number;
  myPoints: number;
  alreadyCounted: boolean;
  elapsedMs: number;
  leftMs: number;
  /** Everyone's points per day on a busy day (busiest recent day's $ × this epoch's average boost). */
  busyPointsPerDay: number;
  pacePoints?: number;
}): EarnRange {
  const { potAnts, totalPoints, myPoints, alreadyCounted } = opts;
  const mine = Math.max(0, myPoints);
  const others = Math.max(0, alreadyCounted ? totalPoints - mine : totalPoints);
  const cap = (potAnts * CLAIM_CAP_BPS) / 10_000;
  const share = (othersAtClose: number) => (mine > 0 ? Math.min(cap, (potAnts * mine) / (othersAtClose + mine)) : 0);
  const leftDays = Math.max(0, opts.leftMs) / DAY_MS;
  // Too early in the epoch to trust its own pace: fall back to the busy pace.
  const elapsedDays = Math.max(0, opts.elapsedMs) / DAY_MS;
  const pace = elapsedDays >= 1 / 24 ? (opts.pacePoints ?? totalPoints) / elapsedDays : opts.busyPointsPerDay;
  const busy = Math.max(opts.busyPointsPerDay, pace * 1.5);
  return {
    now: share(others),
    expected: share(others + pace * leftDays),
    low: share(others + busy * leftDays),
    capped: mine > 0 && (potAnts * mine) / (others + mine) > cap,
  };
}

export function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / DAY_MS);
  const h = Math.floor((ms % DAY_MS) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return d > 0 ? `${d}d ${h}h` : `${h}h ${m}m`;
}

export interface WeekEstimate {
  /** Points the what-if spend adds: $ × boost. */
  addedPoints: number;
  /** This buyer's points for the epoch, the what-if spend included. */
  points: number;
  /** ANTS one of those points is worth at today's rate (after the cap). */
  antsPerPoint: number;
  /** Today's estimate for the epoch (the most it can be worth), with the 5% cap. */
  now: number;
  capped: boolean;
  /** The likely range at close; null when the epoch's start or end is unknown. */
  range: EarnRange | null;
  /** Time until the epoch closes; null when unknown. */
  leftMs: number | null;
}

/**
 * Everything the Rewards calculators show (console and desktop), in one place:
 * this buyer's points so far plus a what-if spend with a provider, today's
 * estimate, and the projected range at close (`projectRange`). Free usage earns
 * nothing, so pass boost 0 for a free provider.
 */
export function weekEstimate(opts: {
  potAnts: number;
  totalPoints: number;
  myPoints: number;
  spendUsd: number;
  boost: number;
  startsAt: number | null;
  endsAt: number | null;
  busyPointsPerDay: number | null;
  now: number;
}): WeekEstimate {
  const today = spendEstimate(opts);
  const total = Math.max(opts.totalPoints, opts.myPoints);
  const antsPerPoint = today.points > 0 ? today.ants / today.points : total > 0 ? opts.potAnts / total : 0;
  const known = opts.startsAt !== null && opts.endsAt !== null;
  const range = known ? projectRange({
    potAnts: opts.potAnts,
    totalPoints: total + today.addedPoints,
    myPoints: today.points,
    alreadyCounted: true,
    pacePoints: total,
    elapsedMs: opts.now - opts.startsAt!,
    leftMs: opts.endsAt! - opts.now,
    busyPointsPerDay: opts.busyPointsPerDay ?? 0,
  }) : null;
  return {
    addedPoints: today.addedPoints,
    points: today.points,
    antsPerPoint,
    now: today.ants,
    capped: today.capped,
    range,
    leftMs: opts.endsAt === null ? null : Math.max(0, opts.endsAt - opts.now),
  };
}

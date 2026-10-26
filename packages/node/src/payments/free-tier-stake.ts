/**
 * Staked free-tier projections: the power a buyer's counted seller-pool stake
 * has at a given time, the tier it earns under a program, and when that
 * drops. Pure and browser-safe (no ethers), so desktop, the gateway console
 * and the CLI share one implementation; re-exported from
 * `@antseed/node/free-tier-program`.
 */
import type { FreeTierStakeTier } from './free-tier-program.js';

/** Most positions a seller counts toward one buyer's tier; the strongest are counted first. */
export const MAX_FREE_TIER_COUNTED_POSITIONS = 64;

/** Epochs of power a max-locked position keeps (the seller pool's `MAX_STAKE_EPOCHS`). */
export const FREE_TIER_MAX_LOCK_EPOCHS = 104;

/**
 * One seller-pool position whose stake counts toward a buyer's free tier: the
 * buyer's own, or a staker's that shared it with a code.
 */
export interface FreeTierStakePositionView {
  id: number;
  staker: string;
  /** Weighted ANTS (whole ANTS, may be fractional); power is this × epochs of lock remaining. */
  ants: number;
  /** First epoch the position has power (it activates a week or more after staking). */
  startEpoch: number;
  /** Epoch the lock ends; power reaches zero then (not while max-locked). */
  endEpoch: number;
  /** Epoch a moved, split or merged position stops counting (its replacements take over), or null. */
  closedAtEpoch: number | null;
  /** Max lock is on this epoch: power is `ants × FREE_TIER_MAX_LOCK_EPOCHS`. */
  maxLocked: boolean;
  /**
   * Max lock is on from the next epoch. Turning it on or off takes effect at
   * the next epoch, so this can differ from `maxLocked` until then.
   */
  maxLockedNext: boolean;
  /** Unix seconds the staker's code expires, or null for the buyer's own stake. */
  expiresAt: number | null;
}

/** A buyer's stake in one seller's pool, as that seller's staked free tier counts it. */
export interface FreeTierPoolStakeView {
  agentId: number;
  positions: FreeTierStakePositionView[];
}

/** Every pool a buyer has counted stake in, and the epoch clock to date its changes. */
export interface FreeTierStakeView {
  currentEpoch: number;
  /** Unix seconds epoch 0 starts. */
  genesis: number;
  /** Seconds per epoch. */
  epochDuration: number;
  pools: FreeTierPoolStakeView[];
}

/** Unix seconds `epoch` starts. */
export function freeTierEpochStart(view: Pick<FreeTierStakeView, 'genesis' | 'epochDuration'>, epoch: number): number {
  return view.genesis + epoch * view.epochDuration;
}

/**
 * Power of `positions` at unix second `at`, in ANTS-epochs, as sellers count
 * it: each position from activation, `ants × epochs left` (max lock:
 * `ants × FREE_TIER_MAX_LOCK_EPOCHS`), until it closes or its code expires,
 * summed over the strongest `MAX_FREE_TIER_COUNTED_POSITIONS`.
 * Locks change at epoch boundaries; a code stops counting the second it expires.
 */
export function freeTierPowerAt(
  view: Pick<FreeTierStakeView, 'currentEpoch' | 'genesis' | 'epochDuration'>,
  positions: readonly FreeTierStakePositionView[],
  at: number,
): number {
  const epoch = Math.floor((at - view.genesis) / view.epochDuration);
  const counted: Array<{ id: number; power: number }> = [];
  for (const position of positions) {
    if (position.expiresAt !== null && position.expiresAt <= at) continue;
    if (epoch < position.startEpoch || (position.closedAtEpoch !== null && epoch >= position.closedAtEpoch)) continue;
    // A max-lock change made this epoch applies from the next one.
    const locked = epoch <= view.currentEpoch ? position.maxLocked : position.maxLockedNext;
    const power = position.ants * (locked ? FREE_TIER_MAX_LOCK_EPOCHS : Math.max(0, position.endEpoch - epoch));
    if (power > 0) counted.push({ id: position.id, power });
  }
  // Sellers count only the strongest positions (ties by lower id), so the projection does too.
  counted.sort((a, b) => (a.power === b.power ? a.id - b.id : b.power - a.power));
  let power = 0;
  for (const position of counted.slice(0, MAX_FREE_TIER_COUNTED_POSITIONS)) power += position.power;
  return power;
}

/** The tier `power` (ANTS-epochs) reaches, or null below the first. */
export function freeTierTierAt(tiers: readonly FreeTierStakeTier[], power: number): FreeTierStakeTier | null {
  let match: FreeTierStakeTier | null = null;
  for (const tier of tiers) {
    if (power >= tier.minPower) match = tier;
  }
  return match;
}

/** Where a buyer's stake in one pool stands against a program's tiers, and when that changes. */
export interface FreeTierOutlook {
  /** Power now, in ANTS-epochs. */
  power: number;
  tier: FreeTierStakeTier | null;
  /** Unix seconds the stake first earns a lower tier, or null when it holds (max lock) or is below every tier. */
  dropsAt: number | null;
  /** The tier from `dropsAt` on; null means below every tier. */
  tierAfterDrop: FreeTierStakeTier | null;
}

/**
 * The future instants counted power can change, in order: each epoch start
 * until the last lock ends, and each code expiry. `epochStart` marks the
 * weekly lock run-down, as opposed to a code expiring.
 */
function changePoints(
  view: Pick<FreeTierStakeView, 'currentEpoch' | 'genesis' | 'epochDuration'>,
  positions: readonly FreeTierStakePositionView[],
  now: number,
): Array<{ at: number; epochStart: boolean }> {
  const lastEpoch = Math.min(
    Math.max(view.currentEpoch, ...positions.map((position) => position.endEpoch)) + 1,
    view.currentEpoch + 10 * FREE_TIER_MAX_LOCK_EPOCHS,
  );
  const points = new Map<number, boolean>();
  for (let epoch = view.currentEpoch + 1; epoch <= lastEpoch; epoch++) points.set(freeTierEpochStart(view, epoch), true);
  for (const position of positions) {
    if (position.expiresAt !== null && position.expiresAt > now && !points.has(position.expiresAt)) points.set(position.expiresAt, false);
  }
  return [...points].filter(([at]) => at > now).sort(([a], [b]) => a - b).map(([at, epochStart]) => ({ at, epochStart }));
}

/**
 * The tier `pool`'s stake earns at `now` (unix seconds) under `tiers`, and
 * when it first earns less: power shrinks every epoch as locks run down, and
 * a staker's code stops counting when it expires.
 */
export function freeTierOutlook(
  view: Pick<FreeTierStakeView, 'currentEpoch' | 'genesis' | 'epochDuration'>,
  pool: { readonly positions: readonly FreeTierStakePositionView[] } | null | undefined,
  tiers: readonly FreeTierStakeTier[],
  now = Math.floor(Date.now() / 1000),
): FreeTierOutlook {
  const positions = pool?.positions ?? [];
  const power = freeTierPowerAt(view, positions, now);
  const tier = freeTierTierAt(tiers, power);
  if (!tier) return { power, tier, dropsAt: null, tierAfterDrop: null };
  const rank = (candidate: FreeTierStakeTier | null) => candidate ? tiers.indexOf(candidate) : -1;
  for (const { at } of changePoints(view, positions, now)) {
    // Stake still activating can raise power; only a lower tier is a drop.
    const next = freeTierTierAt(tiers, freeTierPowerAt(view, positions, at));
    if (rank(next) < rank(tier)) return { power, tier, dropsAt: at, tierAfterDrop: next };
  }
  return { power, tier, dropsAt: null, tierAfterDrop: null };
}

/** How a pool's counted stake changes from now: steady, or shrinking weekly until a date. */
export interface FreeTierStakeTrend {
  /** Power now, in ANTS-epochs. */
  power: number;
  /** Counted power never drops from here (max lock, no code expiring): it holds. */
  steady: boolean;
  /** Counted power drops at some epoch boundary as a lock runs down (not only when a code expires). */
  shrinking: boolean;
  /** Unix seconds counted power reaches zero, or null when it never does. */
  endsAt: number | null;
}

/**
 * How `pool`'s counted power changes from `now`, following the same rules as
 * `freeTierPowerAt` (only the strongest positions count), so positions that
 * are never counted do not make a steady stake look like it shrinks.
 */
export function freeTierStakeTrend(
  view: Pick<FreeTierStakeView, 'currentEpoch' | 'genesis' | 'epochDuration'>,
  pool: { readonly positions: readonly FreeTierStakePositionView[] },
  now = Math.floor(Date.now() / 1000),
): FreeTierStakeTrend {
  const power = freeTierPowerAt(view, pool.positions, now);
  let previousAt = now;
  let steady = power > 0;
  let shrinking = false;
  let endsAt: number | null = null;
  for (const { at, epochStart } of changePoints(view, pool.positions, now)) {
    const next = freeTierPowerAt(view, pool.positions, at);
    if (next < power) steady = false;
    if (epochStart && !shrinking) {
      // Lock run-down only: compare the positions still counting at `at` before and after the boundary,
      // so a code expiring on the same boundary is not mistaken for shrinking.
      const remaining = pool.positions.filter((position) => position.expiresAt === null || position.expiresAt > at);
      if (freeTierPowerAt(view, remaining, at) < freeTierPowerAt(view, remaining, previousAt)) shrinking = true;
    }
    previousAt = at;
    if (next === 0 && power > 0) {
      endsAt = at;
      break;
    }
  }
  return { power, steady, shrinking, endsAt };
}

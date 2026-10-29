import type { PoolView, PoolYield, PositionView } from '../../src/api-types';

export const REFERENCE_STAKE = 10000n * 10n ** 18n;
const DAY = 86400;

export const YIELD_DISPLAY_LIMIT = 10_000;
export const EXTREME_YIELD_LABEL = '>10.000%';
export const EXTREME_YIELD_NOTE = `APR is shown as ${EXTREME_YIELD_LABEL} when it exceeds 10,000%.`;

export function formatYieldPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > YIELD_DISPLAY_LIMIT) return EXTREME_YIELD_LABEL;
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

/** Simple (not compounded) annual rate: the epoch's reward on principal, repeated for a year. */
function annualizedApr(epochReward: bigint, principal: bigint, duration: number): number | null {
  const rate = Number(epochReward * 10n ** 18n / principal) / 1e18;
  const apr = rate * (365 * DAY / duration) * 100;
  return Number.isFinite(apr) ? apr : null;
}

/**
 * Epoch reward for power that is not yet in the pool. The pool's points are its
 * usage times its power, so added power also grows the pool's share of the staker
 * budget; pool size cancels and only the network-wide points dilute:
 *   budget × usage × p / (allPoints + usage × p) = reward × p × budget / (budget × poolPower + reward × p)
 * Without a known budget it falls back to the pool-only split reward × p / (poolPower + p).
 */
export function addedPowerReward(reward: bigint, poolPower: bigint, power: bigint, budget: bigint | null): bigint {
  if (budget !== null && budget > 0n && poolPower > 0n) return reward * power * budget / (budget * poolPower + reward * power);
  return reward * power / (poolPower + power);
}

function bigOrNull(value: string | null | undefined): bigint | null {
  if (value == null) return null;
  try { return BigInt(value); } catch { return null; }
}

export function positionApr(position: PositionView, pool: PoolView | undefined, currentEpoch: number | undefined, maxLockEpochs?: number): number | null {
  const history = pool?.yield;
  if (!pool || pool.agentId !== position.agentId || !history || history.status === 'unavailable' || history.epoch < 0 || history.reward == null ||
      currentEpoch === undefined || !Number.isSafeInteger(currentEpoch) || currentEpoch < 0 ||
      position.withdrawn || position.closedAtEpoch !== 0 || position.state === 'closed' || position.state === 'withdrawn' || position.state === 'matured') return null;
  const duration = history.endsAt - history.startsAt;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  try {
    const principal = BigInt(position.amount);
    const poolPower = BigInt(pool.weight);
    const reward = BigInt(history.reward);
    if (principal <= 0n || poolPower < 0n || reward < 0n) return null;
    const pending = position.stakeStartEpoch > currentEpoch;
    const powerRead = pending ? position.stakeStartEpoch === currentEpoch + 1 ? position.nextPower : undefined : position.power;
    let power: bigint;
    if (powerRead != null) power = BigInt(powerRead);
    else {
      const maxLocked = pending ? position.maxLockedNext : position.maxLocked;
      const epochs = maxLocked ? maxLockEpochs : position.stakeEndEpoch - Math.max(currentEpoch, position.stakeStartEpoch);
      if (epochs === undefined || !Number.isSafeInteger(epochs) || epochs <= 0) return null;
      const weight = BigInt(position.weightAmount);
      if (weight <= 0n) return null;
      power = weight * BigInt(epochs);
    }
    if (power <= 0n) return null;
    if (!pending && (poolPower <= 0n || power > poolPower)) return null;
    const epochReward = pending ? addedPowerReward(reward, poolPower, power, bigOrNull(history.budget)) : reward * power / poolPower;
    return annualizedApr(epochReward, principal, duration);
  } catch {
    return null;
  }
}

function lockPeriod(info: PoolYield | undefined, days: number | 'max'): { epochs: number | null; actualDays: number | null; status: 'supported' | 'unsupported' | 'unavailable' } {
  const duration = info ? info.endsAt - info.startsAt : 0;
  if (!info || !Number.isFinite(duration) || duration <= 0 || info.minLockEpochs == null || info.maxLockEpochs == null) {
    return { epochs: null, actualDays: null, status: 'unavailable' };
  }
  const epochs = days === 'max' ? info.maxLockEpochs : Math.round(days * DAY / duration);
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs < info.minLockEpochs || epochs > info.maxLockEpochs) {
    return { epochs: null, actualDays: null, status: 'unsupported' };
  }
  return { epochs, actualDays: epochs * duration / DAY, status: 'supported' };
}

/** Initial APR and per-epoch ANTS for a new stake: what it would earn if the source epoch repeated. */
export interface StakeEstimate { apr: number | null; epochReward: bigint | null; }

const NO_ESTIMATE: StakeEstimate = { apr: null, epochReward: null };

export function stakeEstimate(info: PoolYield | undefined, epochs: number, amount: string, weightBonusBps = 0): StakeEstimate {
  if (!info || info.status === 'unavailable' || info.epoch < 0 || info.reward == null || info.power == null ||
      info.minLockEpochs == null || info.maxLockEpochs == null) return NO_ESTIMATE;
  const duration = info.endsAt - info.startsAt;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(epochs) || epochs < 1 ||
      epochs < info.minLockEpochs || epochs > info.maxLockEpochs || !Number.isSafeInteger(weightBonusBps) || weightBonusBps < 0) return NO_ESTIMATE;
  try {
    const reward = BigInt(info.reward);
    const poolPower = BigInt(info.power);
    const principal = BigInt(amount);
    if (reward < 0n || poolPower <= 0n || principal <= 0n) return NO_ESTIMATE;
    const weightAmount = principal * (10_000n + BigInt(weightBonusBps)) / 10_000n;
    const epochReward = addedPowerReward(reward, poolPower, weightAmount * BigInt(epochs), bigOrNull(info.budget));
    const apr = annualizedApr(epochReward, principal, duration);
    return apr === null ? NO_ESTIMATE : { apr, epochReward };
  } catch {
    return NO_ESTIMATE;
  }
}

export function stakeApr(info: PoolYield | undefined, epochs: number, amount: string, weightBonusBps = 0): number | null {
  return stakeEstimate(info, epochs, amount, weightBonusBps).apr;
}

function lockEstimate(info: PoolYield | undefined, days: number | 'max'): StakeEstimate & { epochs: number | null } {
  const { epochs } = lockPeriod(info, days);
  if (epochs === null) return { epochs: null, ...NO_ESTIMATE };
  const estimate = stakeEstimate(info, epochs, REFERENCE_STAKE.toString());
  return { epochs: estimate.apr === null ? null : epochs, ...estimate };
}

/** The two ends a staker chooses between: the shortest lock and max lock (the most power per ANTS). */
export function poolAprRange(info: PoolYield | undefined) {
  return { oneWeek: lockEstimate(info, 7), maxLock: lockEstimate(info, 'max') };
}

export function poolAprEstimates(info: PoolYield | undefined) {
  return [
    { label: '1 week', days: 7 as const }, { label: '1 month', days: 30 as const },
    { label: '1 year', days: 365 as const }, { label: 'Max lock', days: 'max' as const },
  ].map(period => ({ ...period, ...lockPeriod(info, period.days), ...lockEstimate(info, period.days) }));
}

/** Max-lock APR to rank pools by: the last complete epoch, or the epoch in progress for a pool with no history yet. */
export function poolHeadlineApr(pool: PoolView): number | null {
  return poolAprRange(pool.yield).maxLock.apr ?? poolAprRange(pool.liveYield).maxLock.apr;
}

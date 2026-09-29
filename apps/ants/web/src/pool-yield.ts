import type { PoolView, PoolYield, PositionView } from '../../src/api-types';

const REFERENCE_STAKE = 10000n * 10n ** 18n;
const DAY = 86400;

export const YIELD_DISPLAY_LIMIT = 10_000;
export const EXTREME_YIELD_LABEL = '>10.000%';
export const EXTREME_YIELD_NOTE = `APY is shown as ${EXTREME_YIELD_LABEL} when either end of the range exceeds 10,000%. Ranges at or below 10,000% remain visible.`;

export function formatYieldPercent(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value > YIELD_DISPLAY_LIMIT) return EXTREME_YIELD_LABEL;
  return `${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%`;
}

function annualizedApy(epochReward: bigint, principal: bigint, duration: number): number | null {
  const rate = Number(epochReward * 10n ** 18n / principal) / 1e18;
  const apy = Math.expm1(Math.log1p(rate) * (365 * DAY / duration)) * 100;
  return Number.isFinite(apy) ? apy : null;
}

export function positionApy(position: PositionView, pool: PoolView | undefined, currentEpoch: number | undefined, maxLockEpochs?: number): number | null {
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
    const totalPower = pending ? poolPower + power : poolPower;
    if (totalPower <= 0n || power > totalPower) return null;
    return annualizedApy(reward * power / totalPower, principal, duration);
  } catch {
    return null;
  }
}

function lockPeriod(info: PoolYield | undefined, days: number): { epochs: number | null; actualDays: number | null; status: 'supported' | 'unsupported' | 'unavailable' } {
  const duration = info ? info.endsAt - info.startsAt : 0;
  if (!info || !Number.isFinite(duration) || duration <= 0 || info.minLockEpochs == null || info.maxLockEpochs == null) {
    return { epochs: null, actualDays: null, status: 'unavailable' };
  }
  const epochs = Math.round(days * DAY / duration);
  if (!Number.isSafeInteger(epochs) || epochs < 1 || epochs < info.minLockEpochs || epochs > info.maxLockEpochs) {
    return { epochs: null, actualDays: null, status: 'unsupported' };
  }
  return { epochs, actualDays: epochs * duration / DAY, status: 'supported' };
}

function lockApy(info: PoolYield | undefined, days: number): { epochs: number | null; apy: number | null } {
  const { epochs } = lockPeriod(info, days);
  if (epochs === null) return { epochs: null, apy: null };
  const apy = stakeApy(info, epochs, REFERENCE_STAKE.toString());
  return { epochs: apy === null ? null : epochs, apy };
}

export function stakeApy(info: PoolYield | undefined, epochs: number, amount: string, weightBonusBps = 0): number | null {
  if (!info || info.status === 'unavailable' || info.epoch < 0 || info.reward == null || info.power == null ||
      info.minLockEpochs == null || info.maxLockEpochs == null) return null;
  const duration = info.endsAt - info.startsAt;
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isSafeInteger(epochs) || epochs < 1 ||
      epochs < info.minLockEpochs || epochs > info.maxLockEpochs || !Number.isSafeInteger(weightBonusBps) || weightBonusBps < 0) return null;
  try {
    const reward = BigInt(info.reward);
    const poolPower = BigInt(info.power);
    const principal = BigInt(amount);
    if (reward < 0n || poolPower <= 0n || principal <= 0n) return null;
    const weightAmount = principal * (10_000n + BigInt(weightBonusBps)) / 10_000n;
    const stakePower = weightAmount * BigInt(epochs);
    const epochReward = reward * stakePower / (poolPower + stakePower);
    return annualizedApy(epochReward, principal, duration);
  } catch {
    return null;
  }
}

export function poolApyRange(info: PoolYield | undefined) {
  return { oneWeek: lockApy(info, 7), twoYears: lockApy(info, 730) };
}

export function poolApyEstimates(info: PoolYield | undefined) {
  return [
    { label: '1 day', days: 1 }, { label: '1 month', days: 30 },
    { label: '1 year', days: 365 }, { label: '2 years', days: 730 },
  ].map(period => ({ ...period, ...lockPeriod(info, period.days), apy: lockApy(info, period.days).apy }));
}

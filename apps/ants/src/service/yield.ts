import type { PoolYield } from '../api-types.js';
/** Token-denominated pool average, using the same completed epoch for rewards and principal. */
export function poolYield(reward: bigint | null, principal: bigint | null, epoch: number, duration: number, genesis: number, settled: boolean): PoolYield {
  const base = { epoch, startsAt: genesis + epoch * duration, endsAt: genesis + (epoch + 1) * duration };
  if (epoch < 0 || duration <= 0 || reward === null || principal === null || principal <= 0n || reward < 0n) return { ...base, apr: null, apy: null, status: 'unavailable' };
  const rate = Number(reward * 10n ** 18n / principal) / 1e18;
  const periods = 365 * 86400 / duration;
  const apr = rate * periods * 100;
  const apy = Math.expm1(Math.log1p(rate) * periods) * 100;
  return { ...base, apr: Number.isFinite(apr) ? apr : null, apy: Number.isFinite(apy) ? apy : null, status: settled ? 'settled' : 'estimated' };
}

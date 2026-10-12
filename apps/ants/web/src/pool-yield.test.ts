import { describe, expect, it } from 'vitest';
import type { PoolView, PoolYield, PositionView } from '../../src/api-types';
import { formatYieldPercent, poolApyRange, poolApyEstimates, positionApy, stakeApy } from './pool-yield';

const unit = 10n ** 18n;
const history: PoolYield = {
  epoch: 20, startsAt: 0, endsAt: 604800, status: 'settled', apr: 0, apy: 0,
  reward: (100n * unit).toString(), power: (10000n * unit).toString(), minLockEpochs: 1, maxLockEpochs: 104,
};

describe('selected stake APY', () => {
  it('uses the selected amount and lock, including the added pool power', () => {
    const amount = (1000n * unit).toString();
    expect(stakeApy(history, 1, amount)).toBeCloseTo(((1 + 100 / 11000) ** (365 / 7) - 1) * 100);
    expect(stakeApy(history, 52, amount)).toBeCloseTo(((1 + 100 * 52 / 62000) ** (365 / 7) - 1) * 100);
    expect(stakeApy(history, 52, amount)).toBeGreaterThan(stakeApy(history, 1, amount)!);
    expect(stakeApy(history, 52, (10000n * unit).toString())).toBeLessThan(stakeApy(history, 52, amount)!);
  });

  it('includes an applicable weight bonus without increasing principal', () => {
    const apy = stakeApy(history, 52, (1000n * unit).toString(), 1000);
    expect(apy).toBeCloseTo(((1 + (100 * 57200 / 67200) / 1000) ** (365 / 7) - 1) * 100);
    expect(apy).toBeGreaterThan(stakeApy(history, 52, (1000n * unit).toString())!);
  });

  it('keeps missing inputs distinct from a genuine zero yield', () => {
    expect(stakeApy(undefined, 52, unit.toString())).toBeNull();
    expect(stakeApy({ ...history, reward: '0' }, 52, unit.toString())).toBe(0);
    for (const amount of ['', '0', '-1', 'bad']) expect(stakeApy(history, 52, amount)).toBeNull();
    for (const epochs of [0, 105, 1.5, NaN]) expect(stakeApy(history, epochs, unit.toString())).toBeNull();
    expect(stakeApy(history, 52, unit.toString(), -1)).toBeNull();
  });
});

describe('existing position APY', () => {
  const units = (amount: number) => (BigInt(amount) * unit).toString();
  const position = {
    id: 1, agentId: 42, amount: units(100), weightAmount: units(100), power: units(200),
    stakeStartEpoch: 20, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false,
    state: 'active', maxLocked: false, maxLockedNext: false,
  } as PositionView;
  const pool = { agentId: 42, weight: units(1000), yield: { ...history, reward: units(10) } } as PoolView;
  const annual = (rate: number) => Math.expm1(Math.log1p(rate) * (365 / 7)) * 100;

  it('does not add an active position to pool power a second time', () => {
    expect(positionApy(position, pool, 25, 104)).toBeCloseTo(annual(10 * 200 / 1000 / 100));
  });

  it('adds pending activation power, not its zero current power', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 26, power: '0', nextPower: units(300) };
    expect(positionApy(pending, pool, 25, 104)).toBeCloseTo(annual(10 * 300 / 1300 / 100));
  });

  it('derives later activation power with the existing weight bonus when next-epoch power is zero', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 28, weightAmount: units(120), power: '0', nextPower: '0' };
    expect(positionApy(pending, pool, 25, 104)).toBeCloseTo(annual(10 * 240 / 1240 / 100));
  });

  it('uses maximum-lock power for pending max locks rather than the old end date', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 26, maxLockedNext: true, power: '0' };
    expect(positionApy(pending, pool, 25, 104)).toBeCloseTo(annual(10 * 10400 / 11400 / 100));
    expect(positionApy(pending, pool, 25)).toBeNull();
  });

  it('uses current on-chain power even if max lock changes next epoch', () => {
    expect(positionApy({ ...position, maxLocked: true, maxLockedNext: false }, pool, 25, 104)).toEqual(positionApy(position, pool, 25, 104));
    expect(positionApy({ ...position, maxLockedNext: true }, pool, 25, 104)).toEqual(positionApy(position, pool, 25, 104));
  });

  it('distinguishes zero rewards from missing or inconsistent data', () => {
    expect(positionApy(position, { ...pool, yield: { ...pool.yield!, reward: '0' } }, 25, 104)).toBe(0);
    expect(positionApy(position, { ...pool, yield: undefined }, 25, 104)).toBeNull();
    expect(positionApy(position, { ...pool, weight: units(100) }, 25, 104)).toBeNull();
    expect(positionApy(position, { ...pool, agentId: 43 }, 25, 104)).toBeNull();
    expect(positionApy(position, pool, undefined, 104)).toBeNull();
    expect(positionApy({ ...position, amount: 'bad' }, pool, 25, 104)).toBeNull();
  });

  it.each([
    { closedAtEpoch: 26 }, { withdrawn: true }, { state: 'closed' as const },
    { state: 'withdrawn' as const }, { state: 'matured' as const },
  ])('does not show ongoing yield for closed or expired positions: %j', changes => {
    expect(positionApy({ ...position, ...changes }, pool, 25, 104)).toBeNull();
  });
});

describe('pool APY lock range', () => {
  it('shows four requested lock durations without inventing a one-day weekly lock', () => {
    const periods = poolApyEstimates(history);
    expect(periods.map(period => period.label)).toEqual(['1 day', '1 month', '1 year', '2 years']);
    expect(periods.map(period => period.epochs)).toEqual([null, 4, 52, 104]);
    expect(periods.map(period => period.actualDays)).toEqual([null, 28, 364, 728]);
    expect(periods[0]).toMatchObject({ status: 'unsupported', apy: null });
    expect(periods[1]!.apy).toBeCloseTo(((1 + 100 * 4 / 50000) ** (365 / 7) - 1) * 100);
    expect(periods[2]!.apy).toBeCloseTo(((1 + 100 * 52 / 530000) ** (365 / 7) - 1) * 100);
    expect(periods[3]!.apy).toEqual(poolApyRange(history).twoYears.apy);
  });

  it('supports a one-day estimate when epochs and pool limits actually allow it', () => {
    const periods = poolApyEstimates({ ...history, endsAt: 86400, maxLockEpochs: 730 });
    expect(periods.map(period => period.epochs)).toEqual([1, 30, 365, 730]);
    expect(periods[0]!.apy).toBeCloseTo(((1 + 100 / 20000) ** 365 - 1) * 100);
    expect(periods.every(period => period.status === 'supported')).toBe(true);
  });

  it('distinguishes missing APY inputs from unsupported lock durations', () => {
    expect(poolApyEstimates(undefined).every(period => period.status === 'unavailable' && period.apy === null)).toBe(true);
    expect(poolApyEstimates({ ...history, maxLockEpochs: 52 })[3]).toMatchObject({ status: 'unsupported', apy: null });
    expect(poolApyEstimates({ ...history, reward: null })[1]).toMatchObject({ status: 'supported', epochs: 4, apy: null });
    expect(poolApyEstimates({ ...history, reward: '0' })[1]!.apy).toBe(0);
  });
  it('calculates one-week and two-year initial rates with 10,000 ANTS added to pool power', () => {
    const range = poolApyRange(history);
    expect(range.oneWeek.epochs).toBe(1);
    expect(range.twoYears.epochs).toBe(104);
    expect(range.oneWeek.apy).toBeCloseTo(((1 + 100 / 20000) ** (365 / 7) - 1) * 100);
    expect(range.twoYears.apy).toBeCloseTo(((1 + 100 * 104 / 1050000) ** (365 / 7) - 1) * 100);
    expect(range.twoYears.apy!).toBeGreaterThan(range.oneWeek.apy!);
  });

  it('uses configured epoch duration and leaves unsupported endpoints unavailable', () => {
    expect(poolApyRange({ ...history, minLockEpochs: 2 }).oneWeek.apy).toBeNull();
    expect(poolApyRange({ ...history, minLockEpochs: 2 }).twoYears.apy).not.toBeNull();
    expect(poolApyRange({ ...history, maxLockEpochs: 52 }).twoYears.apy).toBeNull();
    const daily = poolApyRange({ ...history, endsAt: 86400, maxLockEpochs: 730 });
    expect(daily.oneWeek.epochs).toBe(7);
    expect(daily.twoYears.epochs).toBe(730);
    expect(daily.oneWeek.apy).toBeCloseTo(((1 + 100 * 7 / 80000) ** 365 - 1) * 100);
  });

  it('keeps zero rewards, estimates and missing history distinct', () => {
    expect(poolApyRange({ ...history, reward: '0' })).toEqual({ oneWeek: { epochs: 1, apy: 0 }, twoYears: { epochs: 104, apy: 0 } });
    expect(poolApyRange({ ...history, status: 'estimated' })).toEqual(poolApyRange(history));
    for (const change of [{ reward: null }, { power: null }, { power: '0' }, { reward: '-1' }, { power: 'bad' }, { status: 'unavailable' as const }, { epoch: -1 }, { endsAt: 0 }, { minLockEpochs: null }, { maxLockEpochs: null }]) {
      const range = poolApyRange({ ...history, ...change });
      expect(range.oneWeek.apy).toBeNull();
      expect(range.twoYears.apy).toBeNull();
    }
    expect(poolApyRange(undefined).oneWeek.apy).toBeNull();
    const extreme = poolApyRange({ ...history, reward: (10n ** 100n).toString() });
    expect(extreme.oneWeek.apy).toBeNull();
    expect(extreme.twoYears.apy).toBeNull();
  });
});

describe('pool yield display', () => {
  it('displays two decimal places without scientific notation', () => {
    for (const value of [0, 1, 5.3456, 10, 10.01, 100, 9999.9999, 10000]) {
      const expected = new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value) + '%';
      expect(formatYieldPercent(value)).toBe(expected);
      expect(formatYieldPercent(value)).not.toMatch(/e[+-]/i);
    }
  });

  it('shows >10.000% strictly above 10,000%, before rounding, without changing calculations', () => {
    expect(formatYieldPercent(10000)).toBe('10,000.00%');
    for (const value of [10000.000001, 10000.01, 10001, 1e6, 5.78e35]) expect(formatYieldPercent(value)).toBe('>10.000%');
    expect(poolApyRange(history).oneWeek.apy).toBeGreaterThan(10);
  });

  it('keeps unavailable and non-finite yields distinct from zero', () => {
    for (const value of [null, undefined, Infinity, NaN]) expect(formatYieldPercent(value)).toBe('—');
    expect(formatYieldPercent(0)).toBe('0.00%');
  });
});

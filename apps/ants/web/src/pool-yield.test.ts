import { describe, expect, it } from 'vitest';
import type { PoolView, PoolYield, PositionView } from '../../src/api-types';
import { addedPowerReward, formatYieldPercent, poolAprEstimates, poolAprRange, poolHeadlineApr, positionApr, stakeApr, stakeEstimate } from './pool-yield';

const unit = 10n ** 18n;
const history: PoolYield = {
  epoch: 20, startsAt: 0, endsAt: 604800, status: 'settled', apr: 0, apy: 0,
  reward: (100n * unit).toString(), power: (10000n * unit).toString(), minLockEpochs: 1, maxLockEpochs: 104,
};
const WEEKS = 365 / 7;
/** Simple annual rate from an epoch reward on principal, both in whole ANTS. */
const apr = (epochReward: number, principal: number) => epochReward / principal * WEEKS * 100;

describe('added power reward', () => {
  it('splits the pool reward alone when the budget is unknown', () => {
    expect(addedPowerReward(100n, 1000n, 1000n, null)).toBe(50n);
  });

  it('lets added power grow the pool share, so only network-wide points dilute', () => {
    // Pool holds half the budget's points: reward 100 of budget 200, power 1000.
    // budget × u × p / (S + u × p) with u/S = reward / (budget × power) = 1/2000.
    expect(addedPowerReward(100n, 1000n, 1000n, 200n)).toBe(66n);
    // A pool with the whole budget is never diluted by its own new stake.
    expect(addedPowerReward(100n, 1000n, 1000n, 100n)).toBe(50n);
    // Tiny pools barely dilute the new stake at all.
    expect(addedPowerReward(1n * unit, 1n * unit, 100n * unit, 1000n * unit)).toBeGreaterThan(9n * unit / 10n);
  });
});

describe('selected stake APR', () => {
  it('uses the selected amount and lock, including the added pool power, without compounding', () => {
    const amount = (1000n * unit).toString();
    expect(stakeApr(history, 1, amount)).toBeCloseTo(apr(100 * 1000 / 11000, 1000));
    expect(stakeApr(history, 52, amount)).toBeCloseTo(apr(100 * 52000 / 62000, 1000));
    expect(stakeApr(history, 52, amount)).toBeGreaterThan(stakeApr(history, 1, amount)!);
    expect(stakeApr(history, 52, (10000n * unit).toString())).toBeLessThan(stakeApr(history, 52, amount)!);
  });

  it('counts the stake’s own points when the budget is known', () => {
    const amount = (1000n * unit).toString();
    const withBudget = { ...history, budget: (1000n * unit).toString() };
    expect(stakeApr(withBudget, 52, amount)).toBeCloseTo(apr(100 * 52000 * 1000 / (1000 * 10000 + 100 * 52000), 1000));
    expect(stakeApr(withBudget, 52, amount)).toBeGreaterThan(stakeApr(history, 52, amount)!);
  });

  it('returns the per-epoch ANTS alongside the rate', () => {
    const estimate = stakeEstimate(history, 1, (1000n * unit).toString());
    expect(Number(estimate.epochReward) / 1e18).toBeCloseTo(100 * 1000 / 11000);
  });

  it('includes an applicable weight bonus without increasing principal', () => {
    const rate = stakeApr(history, 52, (1000n * unit).toString(), 1000);
    expect(rate).toBeCloseTo(apr(100 * 57200 / 67200, 1000));
    expect(rate).toBeGreaterThan(stakeApr(history, 52, (1000n * unit).toString())!);
  });

  it('keeps missing inputs distinct from a genuine zero yield', () => {
    expect(stakeApr(undefined, 52, unit.toString())).toBeNull();
    expect(stakeApr({ ...history, reward: '0' }, 52, unit.toString())).toBe(0);
    for (const amount of ['', '0', '-1', 'bad']) expect(stakeApr(history, 52, amount)).toBeNull();
    for (const epochs of [0, 105, 1.5, NaN]) expect(stakeApr(history, epochs, unit.toString())).toBeNull();
    expect(stakeApr(history, 52, unit.toString(), -1)).toBeNull();
    expect(stakeEstimate(undefined, 52, unit.toString())).toEqual({ apr: null, epochReward: null });
  });
});

describe('existing position APR', () => {
  const units = (amount: number) => (BigInt(amount) * unit).toString();
  const position = {
    id: 1, agentId: 42, amount: units(100), weightAmount: units(100), power: units(200),
    stakeStartEpoch: 20, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false,
    state: 'active', maxLocked: false, maxLockedNext: false,
  } as PositionView;
  const pool = { agentId: 42, weight: units(1000), yield: { ...history, reward: units(10) } } as PoolView;

  it('does not add an active position to pool power a second time', () => {
    expect(positionApr(position, pool, 25, 104)).toBeCloseTo(apr(10 * 200 / 1000, 100));
  });

  it('adds pending activation power, not its zero current power', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 26, power: '0', nextPower: units(300) };
    expect(positionApr(pending, pool, 25, 104)).toBeCloseTo(apr(10 * 300 / 1300, 100));
  });

  it('derives later activation power with the existing weight bonus when next-epoch power is zero', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 28, weightAmount: units(120), power: '0', nextPower: '0' };
    expect(positionApr(pending, pool, 25, 104)).toBeCloseTo(apr(10 * 240 / 1240, 100));
  });

  it('uses maximum-lock power for pending max locks rather than the old end date', () => {
    const pending = { ...position, state: 'pending' as const, stakeStartEpoch: 26, maxLockedNext: true, power: '0' };
    expect(positionApr(pending, pool, 25, 104)).toBeCloseTo(apr(10 * 10400 / 11400, 100));
    expect(positionApr(pending, pool, 25)).toBeNull();
  });

  it('uses current on-chain power even if max lock changes next epoch', () => {
    expect(positionApr({ ...position, maxLocked: true, maxLockedNext: false }, pool, 25, 104)).toEqual(positionApr(position, pool, 25, 104));
    expect(positionApr({ ...position, maxLockedNext: true }, pool, 25, 104)).toEqual(positionApr(position, pool, 25, 104));
  });

  it('distinguishes zero rewards from missing or inconsistent data', () => {
    expect(positionApr(position, { ...pool, yield: { ...pool.yield!, reward: '0' } }, 25, 104)).toBe(0);
    expect(positionApr(position, { ...pool, yield: undefined }, 25, 104)).toBeNull();
    expect(positionApr(position, { ...pool, weight: units(100) }, 25, 104)).toBeNull();
    expect(positionApr(position, { ...pool, agentId: 43 }, 25, 104)).toBeNull();
    expect(positionApr(position, pool, undefined, 104)).toBeNull();
    expect(positionApr({ ...position, amount: 'bad' }, pool, 25, 104)).toBeNull();
  });

  it.each([
    { closedAtEpoch: 26 }, { withdrawn: true }, { state: 'closed' as const },
    { state: 'withdrawn' as const }, { state: 'matured' as const },
  ])('does not show ongoing yield for closed or expired positions: %j', changes => {
    expect(positionApr({ ...position, ...changes }, pool, 25, 104)).toBeNull();
  });
});

describe('pool APR lock range', () => {
  it('shows a week, a month, a year and max lock', () => {
    const periods = poolAprEstimates(history);
    expect(periods.map(period => period.label)).toEqual(['1 week', '1 month', '1 year', 'Max lock']);
    expect(periods.map(period => period.epochs)).toEqual([1, 4, 52, 104]);
    expect(periods.map(period => period.actualDays)).toEqual([7, 28, 364, 728]);
    expect(periods[1]!.apr).toBeCloseTo(apr(100 * 40000 / 50000, 10000));
    expect(periods[2]!.apr).toBeCloseTo(apr(100 * 520000 / 530000, 10000));
    expect(periods[3]!.apr).toEqual(poolAprRange(history).maxLock.apr);
    expect(Number(periods[3]!.epochReward) / 1e18).toBeCloseTo(100 * 1040000 / 1050000);
  });

  it('follows the configured max lock and epoch duration', () => {
    const daily = poolAprEstimates({ ...history, endsAt: 86400, maxLockEpochs: 730 });
    expect(daily.map(period => period.epochs)).toEqual([7, 30, 365, 730]);
    expect(daily[0]!.apr).toBeCloseTo(100 * 70000 / 80000 / 10000 * 365 * 100);
    expect(daily.every(period => period.status === 'supported')).toBe(true);
  });

  it('distinguishes missing APR inputs from unsupported lock durations', () => {
    expect(poolAprEstimates(undefined).every(period => period.status === 'unavailable' && period.apr === null)).toBe(true);
    expect(poolAprEstimates({ ...history, maxLockEpochs: 52 })[3]).toMatchObject({ status: 'supported', epochs: 52 });
    expect(poolAprEstimates({ ...history, minLockEpochs: 2 })[0]).toMatchObject({ status: 'unsupported', apr: null });
    expect(poolAprEstimates({ ...history, reward: null })[1]).toMatchObject({ status: 'supported', epochs: null, apr: null });
    expect(poolAprEstimates({ ...history, reward: '0' })[1]!.apr).toBe(0);
  });

  it('calculates one-week and max-lock rates with 10,000 ANTS added to pool power', () => {
    const range = poolAprRange(history);
    expect(range.oneWeek.epochs).toBe(1);
    expect(range.maxLock.epochs).toBe(104);
    expect(range.oneWeek.apr).toBeCloseTo(apr(100 * 10000 / 20000, 10000));
    expect(range.maxLock.apr).toBeCloseTo(apr(100 * 1040000 / 1050000, 10000));
    expect(range.maxLock.apr!).toBeGreaterThan(range.oneWeek.apr!);
  });

  it('keeps zero rewards, estimates and missing history distinct', () => {
    expect(poolAprRange({ ...history, reward: '0' })).toEqual({ oneWeek: { epochs: 1, apr: 0, epochReward: 0n }, maxLock: { epochs: 104, apr: 0, epochReward: 0n } });
    expect(poolAprRange({ ...history, status: 'estimated' })).toEqual(poolAprRange(history));
    for (const change of [{ reward: null }, { power: null }, { power: '0' }, { reward: '-1' }, { power: 'bad' }, { status: 'unavailable' as const }, { epoch: -1 }, { endsAt: 0 }, { minLockEpochs: null }, { maxLockEpochs: null }]) {
      const range = poolAprRange({ ...history, ...change });
      expect(range.oneWeek.apr).toBeNull();
      expect(range.maxLock.apr).toBeNull();
    }
    expect(poolAprRange(undefined).oneWeek.apr).toBeNull();
  });

  it('ranks by the last complete epoch, falling back to the epoch in progress', () => {
    const live = { ...history, epoch: 21, reward: (300n * unit).toString() };
    expect(poolHeadlineApr({ yield: history, liveYield: live } as PoolView)).toEqual(poolAprRange(history).maxLock.apr);
    expect(poolHeadlineApr({ yield: { ...history, status: 'unavailable' }, liveYield: live } as PoolView)).toEqual(poolAprRange(live).maxLock.apr);
    expect(poolHeadlineApr({} as PoolView)).toBeNull();
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
  });

  it('keeps unavailable and non-finite yields distinct from zero', () => {
    for (const value of [null, undefined, Infinity, NaN]) expect(formatYieldPercent(value)).toBe('—');
    expect(formatYieldPercent(0)).toBe('0.00%');
  });
});

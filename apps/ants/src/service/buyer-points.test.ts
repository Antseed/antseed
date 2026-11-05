import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { buyerPoints } from './buyer-points.js';
import { antsPerPoint, formatCountdown, pointsFromWeighted, projectRange, spendEstimate, usageReward, weekEstimate } from './points-math.js';

// 1 point = $1 at 1× = 1e6 (USDC) × 1.04e6 ANTS·epochs × 1e18 (wei).
const ONE_POINT = 1_040_000n * 10n ** 24n;
const WEI = 10n ** 18n;

describe('points math', () => {
  it('converts weighted points and splits a pot with the 5% cap', () => {
    expect(pointsFromWeighted(ONE_POINT * 250n)).toBeCloseTo(250, 9);
    expect(antsPerPoint(1_000, ONE_POINT * 4_000n)).toBeCloseTo(0.25, 12);
    expect(usageReward(1_000, ONE_POINT * 10n, ONE_POINT * 1_000n)).toEqual({ gross: expect.closeTo(10, 9), ants: expect.closeTo(10, 9), capped: false });
    expect(usageReward(1_000, ONE_POINT * 500n, ONE_POINT * 1_000n)).toEqual({ gross: expect.closeTo(500, 9), ants: 50, capped: true });
  });
});

function ctx(options: { pot?: bigint | Error; total?: string; indexer?: boolean } = {}): AntsContext {
  const participant = vi.fn(async () => ({
    address: '0xbuyer', currentEpoch: 27,
    seller: [],
    buyer: [
      { buyer: '0xbuyer', epoch: 27, volumeUsdc: '0', points: '0', weightedPoints: String(ONE_POINT * 120n), requests: '0' },
      { buyer: '0xbuyer', epoch: 25, volumeUsdc: '0', points: '0', weightedPoints: String(ONE_POINT * 40n), requests: '0' },
      { buyer: '0xbuyer', epoch: 24, volumeUsdc: '0', points: '0', weightedPoints: '0', requests: '0' },
    ],
  }));
  const pools = vi.fn(async () => ({
    currentEpoch: 27, pools: [],
    network: { current: { epoch: 27, volumeUsdc: '6000000000', ...(options.total === undefined ? {} : { totalWeightedBuyerPoints: options.total }) }, last: null },
  }));
  // Today first (left out), then the busiest full day at $1,500.
  const dailyVolume = vi.fn(async () => [
    { dayStart: Math.floor(Date.now() / 86_400_000) * 86_400, volumeUsdc: '9000000000' },
    { dayStart: 1, volumeUsdc: '1500000000' },
    { dayStart: 0, volumeUsdc: '500000000' },
  ]);
  return {
    buyerAddress: '0xbuyer',
    indexer: () => (options.indexer === false ? null : { participant, pools, dailyVolume }),
    stack: async () => ({ currentEpoch: 27, genesis: 1_775_728_461, epochDuration: 604_800 }),
    usageRewards: () => ({
      usageEpochBudgets: async () => {
        if (options.pot instanceof Error) throw options.pot;
        return { buyer: options.pot ?? 0n, seller: 0n };
      },
    }),
  } as unknown as AntsContext;
}

describe('spendEstimate', () => {
  it('adds the spend × boost to my points and to everyone’s, then splits the pot', () => {
    // 100 of 1,000 points; $50 at 2× adds 100: 200 of 1,100.
    const estimate = spendEstimate({ potAnts: 1_100, totalPoints: 1_000, myPoints: 100, spendUsd: 50, boost: 2 });
    expect(estimate).toEqual({ addedPoints: 100, points: 200, ants: 55, capped: true });
    expect(spendEstimate({ potAnts: 10_000, totalPoints: 1_000, myPoints: 10, spendUsd: 10, boost: 1 })).toEqual({ addedPoints: 10, points: 20, ants: expect.closeTo(198.02, 2), capped: false });
  });
  it('earns nothing at 0× and never divides by zero', () => {
    expect(spendEstimate({ potAnts: 1_000, totalPoints: 0, myPoints: 0, spendUsd: 100, boost: 0 })).toEqual({ addedPoints: 0, points: 0, ants: 0, capped: false });
    expect(spendEstimate({ potAnts: 1_000, totalPoints: 0, myPoints: 0, spendUsd: 10, boost: 1 }).capped).toBe(true);
  });
});

describe('projectRange (same as the Points site)', () => {
  const base = { potAnts: 250_000, totalPoints: 40_000, myPoints: 800, alreadyCounted: false, elapsedMs: 3 * 86_400_000, leftMs: 4 * 86_400_000, busyPointsPerDay: 20_000 };
  it('orders low ≤ expected ≤ now, with now equal to today’s estimate', () => {
    const r = projectRange(base);
    expect(r.now).toBeCloseTo((250_000 * 800) / 40_800, 6);
    expect(r.expected).toBeCloseTo((250_000 * 800) / (40_000 + (40_000 / 3) * 4 + 800), 6);
    expect(r.low).toBeLessThanOrEqual(r.expected);
  });
  it('collapses to one number when the week is over', () => {
    const r = projectRange({ ...base, leftMs: 0 });
    expect(r.low).toBeCloseTo(r.now, 9);
    expect(r.expected).toBeCloseTo(r.now, 9);
  });
  it('measures the pace from pacePoints, so a what-if spend does not speed up everyone else', () => {
    const counted = projectRange({ ...base, totalPoints: 40_800, alreadyCounted: true, pacePoints: 40_000 });
    expect(counted.expected).toBeCloseTo(projectRange(base).expected, 9);
  });
  it('formats the time left', () => {
    expect(formatCountdown(2 * 86_400_000 + 5 * 3_600_000)).toBe('2d 5h');
    expect(formatCountdown(90 * 60_000)).toBe('1h 30m');
    expect(formatCountdown(0)).toBe('now');
  });
});

describe('weekEstimate', () => {
  const DAY = 86_400_000;
  const base = { potAnts: 250_000, totalPoints: 40_000, myPoints: 0, spendUsd: 50, boost: 16, startsAt: 0, endsAt: 7 * DAY, busyPointsPerDay: 20_000, now: 3 * DAY };
  it('matches the Points site’s calculator for a buyer with no points yet', () => {
    const week = weekEstimate(base);
    const site = projectRange({ potAnts: 250_000, totalPoints: 40_000, myPoints: 800, alreadyCounted: false, elapsedMs: 3 * DAY, leftMs: 4 * DAY, busyPointsPerDay: 20_000 });
    expect(week).toMatchObject({ addedPoints: 800, points: 800, leftMs: 4 * DAY, capped: false });
    expect(week.now).toBeCloseTo(site.now, 6);
    expect(week.range?.expected).toBeCloseTo(site.expected, 6);
    expect(week.range?.low).toBeCloseTo(site.low, 6);
    expect(week.antsPerPoint).toBeCloseTo(week.now / 800, 9);
  });
  it('starts from the buyer’s own points and has no range without the epoch’s dates', () => {
    const week = weekEstimate({ ...base, myPoints: 1_000, totalPoints: 41_000, startsAt: null });
    expect(week.points).toBe(1_800);
    expect(week.now).toBeCloseTo((250_000 * 1_800) / 41_800, 6);
    expect(week.range).toBeNull();
  });
});

describe('buyerPoints', () => {
  it('reads this week’s points, estimates ANTS from the pot and lists points per epoch', async () => {
    const view = await buyerPoints(ctx({ pot: 6_000n * WEI, total: String(ONE_POINT * 12_000n) }));
    expect(view).toMatchObject({ epoch: 27, points: expect.closeTo(120, 9), estimatedAnts: expect.closeTo(60, 9), capped: false });
    expect(view?.potAnts).toBe(6_000);
    expect(view?.startsAt).toBe((1_775_728_461 + 27 * 604_800) * 1000);
    // 12,000 points over $6,000 is 2× on average; the busiest full day was $1,500.
    expect(view?.busyPointsPerDay).toBeCloseTo(3_000, 6);
    expect(view?.totalPoints).toBeCloseTo(12_000, 6);
    expect(view?.endsAt).toBe((1_775_728_461 + 28 * 604_800) * 1000);
    expect(view?.history).toEqual([{ epoch: 27, points: expect.closeTo(120, 9) }, { epoch: 25, points: expect.closeTo(40, 9) }]);
  });

  it('applies the 5% cap', async () => {
    const view = await buyerPoints(ctx({ pot: 1_000n * WEI, total: String(ONE_POINT * 200n) }));
    expect(view).toMatchObject({ estimatedAnts: 50, capped: true });
  });

  it('keeps the points but drops the estimate when the pot or the total is unavailable', async () => {
    expect(await buyerPoints(ctx({ pot: new Error('rpc down'), total: String(ONE_POINT) }))).toMatchObject({ points: expect.closeTo(120, 9), estimatedAnts: null });
    expect(await buyerPoints(ctx({ pot: 1n }))).toMatchObject({ points: expect.closeTo(120, 9), estimatedAnts: null });
  });

  it('is null without an indexer', async () => {
    expect(await buyerPoints(ctx({ indexer: false }))).toBeNull();
  });
});

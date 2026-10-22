import { describe, expect, it } from 'vitest';
import {
  blendedStakerEstimate,
  antsPerPoint,
  boostFromWeight,
  earnEstimate,
  epochAt,
  epochEndMs,
  pointsFromWeighted,
  scaled,
  slashFraction,
  stakerEstimate,
  usageReward,
  projectRange,
} from './points';

// Recorded from Antscan / Base mainnet, epoch 26 (Oct 8–15 2026).
const E26 = {
  buyerPot: 251_200,
  totalWeightedBuyer: '17181693843320017190054049958886821', // network.last.totalWeightedBuyerPoints
  gesundWeight: '4221805945413291390511892', // pool 87124 weight in epoch 26
  topBuyerWeighted: '977445507337124453920261154712956', // 0xb9e7…4553
};

describe('scaled', () => {
  it('converts large integers without overflow', () => {
    expect(scaled('1000000000000000000', 18)).toBe(1);
    expect(scaled(10n ** 40n, 24)).toBeCloseTo(1e16, 0);
    expect(scaled('not a number', 6)).toBe(0);
  });
});

describe('epochs', () => {
  it('matches the emissions gate genesis', () => {
    expect(epochAt(Date.parse('2026-10-20T12:00:00Z'))).toBe(27);
    expect(new Date(epochEndMs(27)).toISOString()).toBe('2026-10-22T09:54:21.000Z');
  });
});

describe('boost', () => {
  it('is pool power over 10,000 ANTS × 104 epochs', () => {
    expect(boostFromWeight(10_000n * 104n * 10n ** 18n)).toBe(1);
    expect(boostFromWeight(E26.gesundWeight)).toBeCloseTo(4.06, 2);
    expect(boostFromWeight('0')).toBe(0);
  });
});

describe('points', () => {
  it('converts weighted points to $ × boost', () => {
    // $100 (1e8 USDC units) through a 1.0× provider = 100 points
    const weighted = 100_000_000n * (10_000n * 104n * 10n ** 18n);
    expect(pointsFromWeighted(weighted)).toBeCloseTo(100, 6);
  });

  it('gives the same ANTS as the pro-rata contract split', () => {
    const rate = antsPerPoint(E26.buyerPot, E26.totalWeightedBuyer);
    const viaPoints = pointsFromWeighted(E26.topBuyerWeighted) * rate;
    const direct = usageReward(E26.buyerPot, E26.topBuyerWeighted, E26.totalWeightedBuyer);
    expect(viaPoints).toBeCloseTo(direct.gross, 6);
    // This buyer took 5.7% of the epoch-26 buyer pot, so the contract caps the claim at 5%.
    expect(direct.capped).toBe(true);
    expect(direct.ants).toBeCloseTo(12_560, 6);
  });

  it('caps one claim at 5% of the pot', () => {
    const r = usageReward(251_200, '90', '100');
    expect(r.gross).toBeCloseTo(226_080, 6);
    expect(r.ants).toBeCloseTo(12_560, 6);
    expect(r.capped).toBe(true);
  });
});

describe('earn estimate', () => {
  // ~29,200 boosted points recorded so far this epoch (10_000 × 104 × 1e18 power per point, × 1e6 USDC units)
  const total = 29_200n * 1_040_000n * 10n ** 24n;

  it('earns nothing at a 0× provider', () => {
    expect(earnEstimate(250_850, total, 100, 0).ants).toBe(0);
  });

  it('includes your own points in the split', () => {
    const r = earnEstimate(250_850, total, 50, 15.9);
    expect(r.points).toBeCloseTo(795, 6);
    expect(r.ants).toBeCloseTo((250_850 * 795) / (29_200 + 795), 3);
    expect(r.capped).toBe(false);
  });

  it('stops at the 5% cap', () => {
    const r = earnEstimate(250_850, total, 10_000, 15.9);
    expect(r.capped).toBe(true);
    expect(r.ants).toBeCloseTo(12_542.5, 6);
  });
});

describe('staker estimate', () => {
  it('is zero for a provider with no volume', () => {
    expect(
      stakerEstimate({ stakerPotAnts: 104_500, providerVolumeUsd: 0, stakeAnts: 1000, lockEpochs: 104, totalPoolWeighted: '1' }),
    ).toBe(0);
  });

  it('grows with volume and lock and never exceeds the pot', () => {
    const base = { stakerPotAnts: 104_500, providerVolumeUsd: 1000, stakeAnts: 1000, totalPoolWeighted: '28552166668508869794274135251968412' };
    const short = stakerEstimate({ ...base, lockEpochs: 10 });
    const long = stakerEstimate({ ...base, lockEpochs: 104 });
    expect(long).toBeGreaterThan(short);
    expect(stakerEstimate({ ...base, stakeAnts: 1e12, lockEpochs: 104 })).toBeLessThanOrEqual(104_500);
  });
});

describe('slash', () => {
  it('follows max(5%, min(50%, 50% × remaining/total))', () => {
    expect(slashFraction(104, 104)).toBe(0.5);
    expect(slashFraction(52, 104)).toBe(0.25);
    expect(slashFraction(1, 104)).toBe(0.05);
    expect(slashFraction(0, 104)).toBe(0);
  });
});

describe('projectRange', () => {
  const base = { potAnts: 250_000, totalPoints: 40_000, myPoints: 800, alreadyCounted: false, elapsedMs: 3 * 86_400_000, leftMs: 4 * 86_400_000, busyPointsPerDay: 20_000 };

  it('orders low ≤ expected ≤ now, with now equal to today’s estimate', () => {
    const r = projectRange(base);
    expect(r.now).toBeCloseTo((250_000 * 800) / 40_800, 6);
    expect(r.expected).toBeLessThan(r.now);
    expect(r.low).toBeLessThanOrEqual(r.expected);
    // Pace so far is 40k/3 days ≈ 13.3k a day, so 4 more days ≈ 53.3k more points.
    expect(r.expected).toBeCloseTo((250_000 * 800) / (40_000 + (40_000 / 3) * 4 + 800), 6);
  });

  it('collapses to one number when the week is over', () => {
    const r = projectRange({ ...base, leftMs: 0 });
    expect(r.low).toBeCloseTo(r.now, 9);
    expect(r.expected).toBeCloseTo(r.now, 9);
  });

  it("doesn't count points already earned twice", () => {
    const r = projectRange({ ...base, alreadyCounted: true, leftMs: 0 });
    expect(r.now).toBeCloseTo((250_000 * 800) / 40_000, 6);
  });

  it('respects the 5% cap', () => {
    const r = projectRange({ ...base, myPoints: 30_000, leftMs: 0 });
    expect(r.now).toBe(12_500);
    expect(r.capped).toBe(true);
  });

  it('uses the busy pace right after the week opens', () => {
    const r = projectRange({ ...base, totalPoints: 10, elapsedMs: 60_000 });
    expect(r.expected).toBeCloseTo((250_000 * 800) / (10 + 20_000 * 4 + 800), 6);
  });
});

describe('blendedStakerEstimate', () => {
  const base = { stakerPotAnts: 100_000, stakeAnts: 1000, lockEpochs: 104, volumeUsd: 10, lastVolumeUsd: 1000 };
  // Early week: one busy provider dominates a tiny total; last week it was a small slice of a big one.
  const totals = { totalPoolWeighted: String(BigInt(20 * 1_000_000) * 10n ** 24n), lastTotalPoolWeighted: String(BigInt(100_000 * 10_000_000) * 10n ** 24n) };
  it('leans on last week right after the reset', () => {
    const start = blendedStakerEstimate({ ...base, ...totals, weekFraction: 0 });
    const thisWeekOnly = stakerEstimate({ stakerPotAnts: 100_000, providerVolumeUsd: 10, stakeAnts: 1000, lockEpochs: 104, totalPoolWeighted: totals.totalPoolWeighted });
    expect(start).toBeLessThan(thisWeekOnly / 10);
  });
  it('is this week only by the end of the week', () => {
    const end = blendedStakerEstimate({ ...base, ...totals, weekFraction: 1 });
    expect(end).toBeCloseTo(stakerEstimate({ stakerPotAnts: 100_000, providerVolumeUsd: 10, stakeAnts: 1000, lockEpochs: 104, totalPoolWeighted: totals.totalPoolWeighted }), 6);
  });
  it('falls back to this week when there is no last week', () => {
    const v = blendedStakerEstimate({ ...base, totalPoolWeighted: totals.totalPoolWeighted, lastTotalPoolWeighted: '0', weekFraction: 0 });
    expect(v).toBeGreaterThan(0);
  });
});


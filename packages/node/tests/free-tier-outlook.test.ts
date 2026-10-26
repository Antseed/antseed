import { describe, expect, it } from 'vitest';
import {
  freeTierEpochStart,
  freeTierOutlook,
  freeTierPowerAt,
  freeTierStakeTrend,
  MAX_FREE_TIER_COUNTED_POSITIONS,
  type FreeTierStakePositionView,
} from '../src/payments/free-tier-stake.js';

const WEEK = 7 * 24 * 3600;
const view = { currentEpoch: 10, genesis: 1_000_000, epochDuration: WEEK };
const at = (epoch: number) => freeTierEpochStart(view, epoch);
// An hour into epoch 10.
const now = at(10) + 3600;
const tiers = [
  { minPower: 1_000_000, multiplier: 10 },
  { minPower: 10_000_000, multiplier: 'unlimited' as const },
];

function position(overrides: Partial<FreeTierStakePositionView>): FreeTierStakePositionView {
  const maxLocked = overrides.maxLocked ?? false;
  return { id: 1, staker: '0x' + '1'.repeat(40), ants: 0, startEpoch: 0, endEpoch: 0, closedAtEpoch: null, maxLocked, maxLockedNext: maxLocked, expiresAt: null, ...overrides };
}

describe('free-tier outlook', () => {
  it('counts power as ANTS × weeks left and finds when a tier drops', () => {
    // 1M ANTS with 10 weeks left: exactly 10M power, unlimited this week only.
    const pool = { positions: [position({ ants: 1_000_000, endEpoch: 20 })] };
    expect(freeTierPowerAt(view, pool.positions, now)).toBe(10_000_000);
    expect(freeTierOutlook(view, pool, tiers, now)).toEqual({ power: 10_000_000, tier: tiers[1], dropsAt: at(11), tierAfterDrop: tiers[0] });
  });

  it('adds positions together and keeps a max-locked tier', () => {
    const pool = { positions: [
      position({ id: 1, ants: 50_000, maxLocked: true, endEpoch: 114 }),
      position({ id: 2, ants: 100_000, endEpoch: 60 }),
    ] };
    // 50k × 104 + 100k × 50 = 10.2M now; the unlocking part takes it below 10M in week 13.
    expect(freeTierOutlook(view, pool, tiers, now)).toMatchObject({ power: 10_200_000, tier: tiers[1], dropsAt: at(13) });
    const locked = { positions: [position({ ants: 100_000, maxLocked: true, endEpoch: 114 })] };
    expect(freeTierOutlook(view, locked, tiers, now)).toMatchObject({ power: 10_400_000, tier: tiers[1], dropsAt: null });
    expect(freeTierStakeTrend(view, locked, now)).toEqual({ power: 10_400_000, steady: true, shrinking: false, endsAt: null });
  });

  it('stops counting a staker the second their code expires', () => {
    const expiresAt = at(12) + 5000;
    const pool = { positions: [position({ ants: 100_000, maxLocked: true, endEpoch: 114, expiresAt })] };
    expect(freeTierOutlook(view, pool, tiers, now)).toMatchObject({ tier: tiers[1], dropsAt: expiresAt, tierAfterDrop: null });
    expect(freeTierPowerAt(view, pool.positions, expiresAt - 1)).toBe(10_400_000);
    expect(freeTierStakeTrend(view, pool, now)).toEqual({ power: 10_400_000, steady: false, shrinking: false, endsAt: expiresAt });
  });

  it('hands a closed position over to its replacements without a drop', () => {
    const pool = { positions: [
      position({ id: 1, ants: 1_000_000, endEpoch: 40, closedAtEpoch: 11 }),
      position({ id: 2, ants: 1_000_000, startEpoch: 11, endEpoch: 40 }),
    ] };
    expect(freeTierOutlook(view, pool, tiers, now)).toMatchObject({ power: 30_000_000, dropsAt: at(31) });
  });

  it('reports no tier below the first and nothing for a missing pool', () => {
    expect(freeTierOutlook(view, null, tiers, now)).toEqual({ power: 0, tier: null, dropsAt: null, tierAfterDrop: null });
    const small = { positions: [position({ ants: 10, endEpoch: 20 })] };
    expect(freeTierOutlook(view, small, tiers, now)).toMatchObject({ power: 100, tier: null, dropsAt: null });
    expect(freeTierStakeTrend(view, small, now)).toMatchObject({ shrinking: true, endsAt: at(20) });
  });

  it('applies a max-lock change made this epoch only from the next one', () => {
    // Enabled this epoch: 100k ANTS with one week left counts 100k now, 10.4M from next week.
    const enabling = { positions: [position({ ants: 100_000, endEpoch: 11, maxLocked: false, maxLockedNext: true })] };
    expect(freeTierPowerAt(view, enabling.positions, at(11) - 1)).toBe(100_000);
    expect(freeTierPowerAt(view, enabling.positions, at(11))).toBe(10_400_000);
    expect(freeTierOutlook(view, enabling, tiers, now)).toMatchObject({ tier: null, dropsAt: null });
    expect(freeTierStakeTrend(view, enabling, now)).toMatchObject({ steady: true, shrinking: false });
    // Disabled this epoch: max power now, then 100k × weeks left from next week (the pool resets the end to next + 104), below 10M in week 16.
    const disabling = { positions: [position({ ants: 100_000, endEpoch: 11 + 104, maxLocked: true, maxLockedNext: false })] };
    expect(freeTierPowerAt(view, disabling.positions, at(11) - 1)).toBe(10_400_000);
    expect(freeTierPowerAt(view, disabling.positions, at(11))).toBe(10_400_000);
    expect(freeTierOutlook(view, disabling, tiers, now)).toMatchObject({ tier: tiers[1], dropsAt: at(16), tierAfterDrop: tiers[0] });
    expect(freeTierStakeTrend(view, disabling, now)).toMatchObject({ steady: false, shrinking: true, endsAt: at(115) });
  });

  it('counts only the strongest positions a seller counts, re-picked as they change', () => {
    // 65 positions of 1,000 ANTS with 8 weeks left: 520,000 power in all, but sellers count 64 (512,000).
    const many = Array.from({ length: MAX_FREE_TIER_COUNTED_POSITIONS + 1 }, (_, index) => position({ id: index + 1, ants: 1_000, endEpoch: 18 }));
    expect(freeTierPowerAt(view, many, now)).toBe(512_000);
    const defaultTiers = [{ minPower: 520_000, multiplier: 5 }];
    expect(freeTierOutlook(view, { positions: many }, defaultTiers, now).tier).toBeNull();
    // A stronger position whose code expires is counted until then, after which the 65th is counted again.
    const expiresAt = at(12);
    const strong = position({ id: 100, ants: 10_000, endEpoch: 18, expiresAt });
    expect(freeTierPowerAt(view, [strong, ...many], now)).toBe(80_000 + 63 * 8_000);
    expect(freeTierPowerAt(view, [strong, ...many], expiresAt)).toBe(64 * 6_000);
  });

  it('describes the trend of the counted positions only', () => {
    // 64 strong max-locked positions hold; a weaker unlocked 65th is never counted, so nothing shrinks.
    const locked = Array.from({ length: MAX_FREE_TIER_COUNTED_POSITIONS }, (_, index) => position({ id: index + 1, ants: 1_000, maxLocked: true, endEpoch: 114 }));
    const weak = position({ id: 99, ants: 10, endEpoch: 30 });
    expect(freeTierStakeTrend(view, { positions: [...locked, weak] }, now)).toEqual({ power: 64 * 104_000, steady: true, shrinking: false, endsAt: null });
    // With a counted slot free, the same weak position is counted and shrinks.
    expect(freeTierStakeTrend(view, { positions: [...locked.slice(1), weak] }, now)).toMatchObject({ steady: false, shrinking: true, endsAt: null });
    // A max-locked code expiring exactly on a week boundary stops counting there; that is not shrinking.
    const onBoundary = position({ ants: 1_000, maxLocked: true, endEpoch: 114, expiresAt: at(30) });
    expect(freeTierStakeTrend(view, { positions: [onBoundary] }, now)).toEqual({ power: 104_000, steady: false, shrinking: false, endsAt: at(30) });
  });
});

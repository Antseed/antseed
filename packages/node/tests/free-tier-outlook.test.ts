import { describe, expect, it } from 'vitest';
import {
  freeTierEpochStart,
  freeTierOutlook,
  freeTierPowerAt,
  freeTierStakeTrend,
  type FreeTierStakePositionView,
} from '../src/payments/free-tier-program.js';

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
  return { id: 1, staker: '0x' + '1'.repeat(40), ants: 0, startEpoch: 0, endEpoch: 0, closedAtEpoch: null, maxLocked: false, expiresAt: null, ...overrides };
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
});

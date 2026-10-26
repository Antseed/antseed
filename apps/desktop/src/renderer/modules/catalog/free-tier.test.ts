import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FreeTierProgram } from '@antseed/node/free-tier-program';
import { freeTierStandingLine, freeTierTrendLine, type BuyerFreeTierStake } from './free-tier';

const WEEK = 604_800;
// Epoch 10 starts Jan 1, 2027 (UTC noon, so the date reads the same in every timezone).
const genesis = Date.UTC(2027, 0, 1, 12) / 1000 - 10 * WEEK;
const buyer = '0x00000000000000000000000000000000000000b1';
const staker = '0x00000000000000000000000000000000000000a1';
const program: FreeTierProgram = {
  base: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: 86_400_000 },
  stakeTiers: [{ minPower: 1_000_000, multiplier: 10 }, { minPower: 10_000_000, multiplier: 'unlimited' }],
};

function stake(positions: Partial<BuyerFreeTierStake['pools'][number]['positions'][number]>[]): BuyerFreeTierStake {
  return {
    buyer,
    currentEpoch: 10,
    genesis,
    epochDuration: WEEK,
    pools: [{ agentId: 7, positions: positions.map((overrides, index) => ({ id: index + 1, staker, ants: 0, startEpoch: 0, endEpoch: 0, closedAtEpoch: null, maxLocked: false, expiresAt: null, ...overrides, maxLockedNext: overrides.maxLockedNext ?? overrides.maxLocked ?? false })) }],
  };
}

// An hour into epoch 10.
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime((genesis + 10 * WEEK + 3600) * 1000) });
afterAll(() => { vi.useRealTimers() });

describe('staked free-tier standing', () => {
  it('says when a tier drops and suggests max lock to the staker', () => {
    const line = freeTierStandingLine(program, stake([{ ants: 1_000_000, endEpoch: 20 }]), 7, false);
    expect(line).toEqual({ text: 'You get unlimited until Jan 8, 2027, then 1,000 a day.', dropsSoon: true, ownStake: false });
  });

  it('knows the buyer can max-lock its own stake, and that a max-locked tier holds', () => {
    expect(freeTierStandingLine(program, stake([{ staker: buyer, ants: 200_000, endEpoch: 20 }]), 7, false)?.ownStake).toBe(true);
    expect(freeTierStandingLine(program, stake([{ ants: 100_000, maxLocked: true, endEpoch: 114 }]), 7, false))
      .toEqual({ text: 'You get unlimited; max lock keeps it.', dropsSoon: false, ownStake: false });
  });

  it('names what a stakers-only or priced program falls back to', () => {
    const stakersOnly = { ...program, base: { ...program.base, stakersOnly: true } };
    const view = stake([{ ants: 200_000, endEpoch: 20 }]);
    expect(freeTierStandingLine(stakersOnly, view, 7, false)?.text).toBe('You get 1,000 a day until Feb 12, 2027, then no free use.');
    expect(freeTierStandingLine(stakersOnly, view, 7, true)?.text).toBe('You get 1,000 a day until Feb 12, 2027, then the listed price.');
  });

  it('shows stake below the first tier and nothing for other pools', () => {
    const view = stake([{ ants: 5_200, endEpoch: 62 }]);
    expect(freeTierStandingLine(program, view, 7, false)?.text).toBe('Your stake here counts as 5,200 ANTS for a year, below the first tier.');
    expect(freeTierStandingLine(program, view, 8, false)).toBeNull();
    expect(freeTierStandingLine(program, null, 7, false)).toBeNull();
  });

  it('describes how a pool shrinks', () => {
    const view = stake([{ ants: 5_200, endEpoch: 62 }]);
    expect(freeTierTrendLine(view, view.pools[0]!)).toBe('Counts as 5,200 ANTS for a year, shrinking weekly until Dec 31, 2027');
    const locked = stake([{ ants: 520, maxLocked: true, endEpoch: 114 }]);
    expect(freeTierTrendLine(locked, locked.pools[0]!)).toBe('Counts as 1,040 ANTS for a year; max lock keeps it');
    const shared = stake([{ ants: 520, maxLocked: true, endEpoch: 114, expiresAt: genesis + 30 * WEEK }]);
    expect(freeTierTrendLine(shared, shared.pools[0]!)).toBe('Counts as 1,040 ANTS for a year; max lock keeps it until the code expires on May 21, 2027');
  });
});

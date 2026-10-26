import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FreeTierProgramView, FreeTierStake, FreeTierStakePosition } from '../api/types'
import { powerAt, stakeStandingLine, stakeTrendLabel } from './free-tier'

const WEEK = 604_800
// Epoch 10 starts Jan 1, 2027 (UTC noon, so the date reads the same in every timezone).
const genesis = Date.UTC(2027, 0, 1, 12) / 1000 - 10 * WEEK
const buyer = `0x${'b1'.repeat(20)}`
const staker = `0x${'a1'.repeat(20)}`
const program: FreeTierProgramView = {
  base: { maxRequestsPerAddress: 100, maxRequestsPerIp: null, windowMs: 86_400_000 },
  stakeTiers: [{ minPower: 1_000_000, multiplier: 10 }, { minPower: 10_000_000, multiplier: 'unlimited' }],
}

function view(positions: Partial<FreeTierStakePosition>[]): FreeTierStake {
  return {
    buyer, currentEpoch: 10, genesis, epochDuration: WEEK,
    pools: [{ agentId: 7, positions: positions.map((overrides, index) => ({ id: index + 1, staker, ants: 0, startEpoch: 0, endEpoch: 0, closedAtEpoch: null, maxLocked: false, expiresAt: null, ...overrides })) }],
  }
}

// An hour into epoch 10.
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime((genesis + 10 * WEEK + 3600) * 1000) })
afterAll(() => { vi.useRealTimers() })

describe('workspace staked standing', () => {
  it('matches the seller pool: ANTS × weeks left, max lock at 104 weeks, nothing after a code expires', () => {
    const stake = view([
      { ants: 1000, endEpoch: 20 },
      { ants: 10, maxLocked: true, endEpoch: 114 },
      { ants: 1, endEpoch: 20, expiresAt: genesis + 11 * WEEK },
    ])
    expect(powerAt(stake, stake.pools[0]!.positions, genesis + 10 * WEEK)).toBe(10_000 + 1_040 + 10)
    expect(powerAt(stake, stake.pools[0]!.positions, genesis + 11 * WEEK)).toBe(9_000 + 1_040)
  })

  it('says when the tier drops, and who can max-lock to keep it', () => {
    expect(stakeStandingLine(program, view([{ ants: 1_000_000, endEpoch: 20 }]), 7, false))
      .toEqual({ text: 'You get unlimited until Jan 8, 2027, then 1,000 a day.', dropsSoon: true, ownStake: false })
    expect(stakeStandingLine(program, view([{ staker: buyer, ants: 1_000_000, endEpoch: 20 }]), 7, false)?.ownStake).toBe(true)
    expect(stakeStandingLine(program, view([{ ants: 100_000, maxLocked: true, endEpoch: 114 }]), 7, false)?.text).toBe('You get unlimited; max lock keeps it.')
    expect(stakeStandingLine(program, view([{ ants: 100_000, maxLocked: true, endEpoch: 114 }]), 8, false)).toBeNull()
  })

  it('labels how a pool changes', () => {
    const stake = view([{ ants: 5_200, endEpoch: 62 }])
    expect(stakeTrendLabel(stake, stake.pools[0]!.positions)).toBe('Shrinking weekly until Dec 31, 2027')
    const mixed = view([{ ants: 5_200, endEpoch: 62 }, { ants: 1, maxLocked: true, endEpoch: 114 }])
    expect(stakeTrendLabel(mixed, mixed.pools[0]!.positions)).toBe('Shrinking weekly; the max-locked part holds')
    const shared = view([{ ants: 1, maxLocked: true, endEpoch: 114, expiresAt: genesis + 30 * WEEK }])
    expect(stakeTrendLabel(shared, shared.pools[0]!.positions)).toBe('Max lock keeps it until the code expires on May 21, 2027')
  })
})

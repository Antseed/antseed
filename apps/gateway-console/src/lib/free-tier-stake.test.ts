import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { FreeTierProgramView, FreeTierStake, FreeTierStakePosition } from '../api/types'
import { isFreeService, stakeStandingLine, stakeTrendLabel } from './free-tier'

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
    pools: [{ agentId: 7, positions: positions.map((overrides, index) => ({ id: index + 1, staker, ants: 0, startEpoch: 0, endEpoch: 0, closedAtEpoch: null, maxLocked: false, expiresAt: null, ...overrides, maxLockedNext: overrides.maxLockedNext ?? overrides.maxLocked ?? false })) }],
  }
}

// An hour into epoch 10.
beforeAll(() => { vi.useFakeTimers(); vi.setSystemTime((genesis + 10 * WEEK + 3600) * 1000) })
afterAll(() => { vi.useRealTimers() })

describe('workspace staked standing', () => {
  it('waits for the next epoch before counting max lock turned on this week', () => {
    // 100k ANTS with one week left is below every tier now; max lock lifts it to unlimited from next week.
    expect(stakeStandingLine(program, view([{ ants: 100_000, endEpoch: 11, maxLocked: false, maxLockedNext: true }]), 7, false)?.text)
      .toBe('Your stake here counts as 1,923 ANTS for a year, below the first tier.')
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

describe('isFreeService', () => {
  const service = { provider: 'fal', service: 'qwen-image', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, categories: [] }
  it("follows the gateway's classification, so a per-image price with zero token prices is paid", () => {
    expect(isFreeService({ ...service, paid: true })).toBe(false)
    expect(isFreeService({ ...service, paid: false })).toBe(true)
  })
  it('falls back to token prices from older gateways', () => {
    expect(isFreeService(service)).toBe(true)
    expect(isFreeService({ ...service, outputUsdPerMillion: 2 })).toBe(false)
  })
})

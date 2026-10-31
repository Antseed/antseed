import { describe, expect, it } from 'vitest'
import type { RewardsPoints } from '../api/types'
import { pointsTileSummary } from './points-summary'
import { weekEstimate } from '../../../ants/src/service/points-math'

const DAY = 86_400_000
// A week from Thursday 15 Oct 09:54 UTC, three days in (Thursday in every zone from UTC-9 to UTC+14).
const start = Date.UTC(2026, 9, 15, 9, 54)
const base: RewardsPoints = { epoch: 27, endsAt: start + 7 * DAY, points: 900, estimatedAnts: 432.69, capped: false, potAnts: 10_000, totalPoints: 20_000, startsAt: start, busyPointsPerDay: 9_000, history: [] }

describe('Points tile summary', () => {
  it('shows the calculator’s projection to the close, with the likely range', () => {
    const week = weekEstimate({ potAnts: 10_000, totalPoints: 20_000, myPoints: 900, spendUsd: 0, boost: 0, startsAt: start, endsAt: start + 7 * DAY, busyPointsPerDay: 9_000, now: start + 3 * DAY })
    expect(pointsTileSummary(base, start + 3 * DAY)).toBe(
      `By Thursday, about ${Math.round(week.range!.expected)} ANTS · likely ${Math.round(week.range!.low)}–${Math.round(week.range!.now)}`,
    )
  })
  it('falls back to today’s rate without the week’s dates, and says when there is nothing yet', () => {
    expect(pointsTileSummary({ ...base, startsAt: null }, start)).toBe('≈ 450 ANTS at today\'s rate')
    expect(pointsTileSummary({ ...base, potAnts: null }, start)).toBe('≈ 433 ANTS at today\'s rate')
    expect(pointsTileSummary({ ...base, points: 0 }, start)).toBe('No points yet this week')
  })
})

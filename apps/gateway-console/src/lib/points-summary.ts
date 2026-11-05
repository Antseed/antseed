import type { RewardsPoints } from '../api/types'
import { weekEstimate } from '../../../ants/src/service/points-math'
import { formatAntsAmount } from './format'

/**
 * The Points tile's line under the number, on the same projection as the
 * calculator (`weekEstimate`, no extra spend): "By Thursday, about 85 ANTS ·
 * likely 60–120". Falls back to today's estimate when the week's dates are
 * unknown, and says so when there is nothing to estimate.
 */
export function pointsTileSummary(points: RewardsPoints, now: number): string {
  if (points.points <= 0) return 'No points yet this week'
  if (points.potAnts === null || points.totalPoints === null) {
    return points.estimatedAnts === null ? 'ANTS estimate unavailable right now' : `≈ ${formatAntsAmount(points.estimatedAnts)} ANTS at today's rate`
  }
  const week = weekEstimate({
    potAnts: points.potAnts, totalPoints: points.totalPoints, myPoints: points.points, spendUsd: 0, boost: 0,
    startsAt: points.startsAt, endsAt: points.endsAt, busyPointsPerDay: points.busyPointsPerDay, now,
  })
  const capped = week.capped ? ' (5% cap)' : ''
  if (!week.range || points.endsAt === null) return `≈ ${formatAntsAmount(week.now)} ANTS at today's rate${capped}`
  const closes = new Date(points.endsAt).toLocaleDateString('en-US', { weekday: 'long' })
  const { expected, low, now: high } = week.range
  const likely = high - low >= 0.01 ? ` · likely ${formatAntsAmount(low)}–${formatAntsAmount(high)}` : ''
  return `By ${closes}, about ${formatAntsAmount(expected)} ANTS${capped}${likely}`
}

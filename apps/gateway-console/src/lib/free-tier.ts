import type { FreeTierProgramView, FreeTierStake, FreeTierStakePosition } from '../api/types'

type StakeTier = FreeTierProgramView['stakeTiers'][number]

/** Tiers are staking power: ANTS × weeks of lock remaining, so a year of lock is 52 weeks. */
const WEEKS_PER_YEAR = 52

/** The console path that opens staking on one seller's pool. */
export function stakeInPoolPath(agentId: number): string {
  return `staking/stake?pool=${agentId}`
}

function per(windowMs: number): string {
  const hours = windowMs / 3_600_000
  if (hours === 24) return 'day'
  if (hours >= 1 && Number.isInteger(hours)) return `${hours} h`
  return `${Math.max(1, Math.round(windowMs / 60_000))} min`
}

/** "1,000 free requests a day", from the per-buyer limit (else the per-IP one). */
export function freeTierBaseLabel(program: FreeTierProgramView): string | null {
  const { maxRequestsPerAddress, maxRequestsPerIp, windowMs } = program.base
  const count = maxRequestsPerAddress ?? maxRequestsPerIp
  if (count === null) return null
  const window = per(windowMs)
  return `${count.toLocaleString('en-US')} free requests ${window === 'day' ? 'a day' : `per ${window}`}${maxRequestsPerAddress === null ? ' per IP' : ''}`
}

/** "a day" or "per 6 h". */
function perWindow(windowMs: number): string {
  const window = per(windowMs)
  return window === 'day' ? 'a day' : `per ${window}`
}

/**
 * The one-line summary of a program on an offer:
 * "1,000 free requests a day" or "Free for stakers" on a free model, and on a
 * priced one its free allowance before the listed price applies.
 */
export function freeTierHeadline(program: FreeTierProgramView, priced: boolean): string {
  if (program.base.stakersOnly) return priced ? 'Free for stakers, others pay' : 'Free for stakers'
  const base = freeTierBaseLabel(program) ?? 'Free'
  return priced ? `${base}, then paid` : base
}

/** What a tier allows, in requests: "5,000 a day" or "Unlimited". */
export function tierLimit(program: FreeTierProgramView, tier: StakeTier): string {
  if (tier.multiplier === 'unlimited') return 'Unlimited'
  const base = program.base.maxRequestsPerAddress ?? program.base.maxRequestsPerIp
  if (base === null) return tierMultiplier(tier)
  return `${(base * tier.multiplier).toLocaleString('en-US')} ${perWindow(program.base.windowMs)}`
}

/** "10,000 ANTS" — the ANTS a tier needs when locked for a year. */
export function tierAnts(tier: StakeTier): string {
  return `${Math.ceil(tier.minPower / WEEKS_PER_YEAR).toLocaleString('en-US')} ANTS`
}

/** "5×" or "Unlimited". */
export function tierMultiplier(tier: StakeTier): string {
  return tier.multiplier === 'unlimited' ? 'Unlimited' : `${tier.multiplier}×`
}

export function tierAllowance(tier: StakeTier): string {
  return tier.multiplier === 'unlimited' ? 'Unlimited' : `${tier.multiplier}× the free limit`
}

/** The first tier above `power` (ANTS-epochs), or null at the top tier. */
export function nextTier(tiers: readonly StakeTier[], power: number): StakeTier | null {
  return tiers.find((tier) => tier.minPower > power) ?? null
}

/**
 * What a tier allows, from a free-tier refusal: "200 free requests a day"
 * when the seller sent its base limit, else "5× the free limit".
 */
export function refusalTierAllowance(limit: { baseLimit?: number | null; windowMs: number | null }, tier: StakeTier): string {
  if (tier.multiplier === 'unlimited') return 'unlimited free use'
  if (limit.baseLimit == null || limit.windowMs === null) return tierAllowance(tier).toLowerCase()
  return `${(limit.baseLimit * tier.multiplier).toLocaleString('en-US')} free requests ${perWindow(limit.windowMs)}`
}

/** Epochs of power a max-locked position keeps (the seller pool's `MAX_STAKE_EPOCHS`). */
const MAX_LOCK_EPOCHS = 104

/** A tier drop this close (in weeks) earns a max-lock hint. */
export const DROP_HINT_WEEKS = 4

type StakeClock = Pick<FreeTierStake, 'currentEpoch' | 'genesis' | 'epochDuration'>

function epochStart(view: StakeClock, epoch: number): number {
  return view.genesis + epoch * view.epochDuration
}

/**
 * Power of `positions` at unix second `at` in ANTS-epochs, as the seller pool
 * counts it (mirrors `freeTierPowerAt` in `@antseed/node`): locks change at
 * epoch starts, and a code stops counting the second it expires.
 */
export function powerAt(view: StakeClock, positions: readonly FreeTierStakePosition[], at: number): number {
  const epoch = Math.floor((at - view.genesis) / view.epochDuration)
  let power = 0
  for (const position of positions) {
    if (position.expiresAt !== null && position.expiresAt <= at) continue
    if (epoch < position.startEpoch || (position.closedAtEpoch !== null && epoch >= position.closedAtEpoch)) continue
    power += position.ants * (position.maxLocked ? MAX_LOCK_EPOCHS : Math.max(0, position.endEpoch - epoch))
  }
  return power
}

function tierAt(tiers: readonly StakeTier[], power: number): StakeTier | null {
  let match: StakeTier | null = null
  for (const tier of tiers) if (power >= tier.minPower) match = tier
  return match
}

/** The tier the stake earns at `now` and when it first earns less (mirrors `freeTierOutlook`). */
export function stakeOutlook(view: StakeClock, positions: readonly FreeTierStakePosition[], tiers: readonly StakeTier[], now = Math.floor(Date.now() / 1000)) {
  const power = powerAt(view, positions, now)
  const tier = tierAt(tiers, power)
  const none = { power, tier, dropsAt: null as number | null, tierAfterDrop: null as StakeTier | null }
  if (!tier) return none
  // Power only changes at epoch starts and code expiries.
  const lastEpoch = Math.min(Math.max(view.currentEpoch, ...positions.map((position) => position.endEpoch)) + 1, view.currentEpoch + 10 * MAX_LOCK_EPOCHS)
  const changes = new Set<number>()
  for (let epoch = view.currentEpoch + 1; epoch <= lastEpoch; epoch++) changes.add(epochStart(view, epoch))
  for (const position of positions) if (position.expiresAt !== null && position.expiresAt > now) changes.add(position.expiresAt)
  const rank = (candidate: StakeTier | null) => candidate ? tiers.indexOf(candidate) : -1
  for (const at of [...changes].filter((change) => change > now).sort((a, b) => a - b)) {
    const next = tierAt(tiers, powerAt(view, positions, at))
    if (rank(next) < rank(tier)) return { power, tier, dropsAt: at, tierAfterDrop: next }
  }
  return none
}

/** "12,000 ANTS for a year": power in the units tiers are shown in. */
export function powerAsYearAnts(power: number): string {
  return `${Math.floor(power / WEEKS_PER_YEAR).toLocaleString('en-US')} ANTS for a year`
}

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

function allowance(program: FreeTierProgramView, tier: StakeTier | null, priced: boolean): string {
  if (tier) return tierLimit(program, tier).replace(/^Unlimited$/, 'unlimited')
  if (program.base.stakersOnly) return priced ? 'the listed price' : 'no free use'
  const base = program.base.maxRequestsPerAddress ?? program.base.maxRequestsPerIp
  return base === null ? 'the free limit' : `${base.toLocaleString('en-US')} ${perWindow(program.base.windowMs)}`
}

/**
 * Where the workspace's stake in `agentId`'s pool stands under `program`:
 * "You get 1,000 a day until Dec 14, 2026, then 100 a day". Null without stake there.
 */
export function stakeStandingLine(program: FreeTierProgramView, view: FreeTierStake | undefined, agentId: number | null, priced: boolean) {
  const pool = view?.pools.find((entry) => entry.agentId === agentId)
  if (!view || !pool) return null
  const outlook = stakeOutlook(view, pool.positions, program.stakeTiers)
  if (outlook.power <= 0) return null
  const ownStake = pool.positions.some((position) => position.staker.toLowerCase() === view.buyer.toLowerCase())
  if (!outlook.tier) return { text: `Your stake here counts as ${powerAsYearAnts(outlook.power)}, below the first tier.`, dropsSoon: false, ownStake }
  const now = allowance(program, outlook.tier, priced)
  if (outlook.dropsAt === null) {
    return { text: `You get ${now}${stakeTrend(view, pool.positions).steady ? '; max lock keeps it' : ''}.`, dropsSoon: false, ownStake }
  }
  return {
    text: `You get ${now} until ${shortDate(outlook.dropsAt)}, then ${allowance(program, outlook.tierAfterDrop, priced)}.`,
    dropsSoon: outlook.dropsAt - Date.now() / 1000 <= DROP_HINT_WEEKS * view.epochDuration,
    ownStake,
  }
}

/** Power now, whether it holds, and when the last of it stops counting (mirrors `freeTierStakeTrend`). */
export function stakeTrend(view: StakeClock, positions: readonly FreeTierStakePosition[], now = Math.floor(Date.now() / 1000)) {
  const power = powerAt(view, positions, now)
  const counted = positions.filter((position) => position.closedAtEpoch === null && (position.expiresAt === null || position.expiresAt > now))
  const ends = counted.map((position) => {
    const lockEnd = position.maxLocked ? null : epochStart(view, position.endEpoch)
    if (lockEnd === null) return position.expiresAt
    return position.expiresAt === null ? lockEnd : Math.min(lockEnd, position.expiresAt)
  })
  const steady = counted.length > 0 && counted.every((position) => position.maxLocked && position.expiresAt === null)
  const shrinking = counted.some((position) => !position.maxLocked)
  const endsAt = ends.length === 0 || ends.some((end) => end === null) ? null : Math.max(...(ends as number[]))
  return { power, steady, shrinking, endsAt }
}

/**
 * "Shrinking weekly until Mar 3, 2027", "Max lock keeps it", "Max lock keeps it
 * until the code expires on <date>", or "Shrinking weekly; the max-locked part holds".
 */
export function stakeTrendLabel(view: StakeClock, positions: readonly FreeTierStakePosition[]): string {
  const trend = stakeTrend(view, positions)
  if (trend.steady) return 'Max lock keeps it'
  if (!trend.shrinking && trend.endsAt !== null) return `Max lock keeps it until the code expires on ${shortDate(trend.endsAt)}`
  if (trend.endsAt === null) return 'Shrinking weekly; the max-locked part holds'
  return `Shrinking weekly until ${shortDate(trend.endsAt)}`
}

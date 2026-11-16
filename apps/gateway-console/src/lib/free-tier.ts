import { freeTierOutlook, freeTierStakeTrend } from '@antseed/node/free-tier-stake'
import type { FreeTierProgramView, FreeTierStake, FreeTierStakePosition, Peer } from '../api/types'

type StakeTier = FreeTierProgramView['stakeTiers'][number]

/** Tiers are staking power: ANTS × weeks of lock remaining, so a year of lock is 52 weeks. */
const WEEKS_PER_YEAR = 52

/**
 * A provider's service has no listed price. The gateway classifies it, counting
 * per-unit (image, video) prices too; older gateways send token prices only.
 */
export function isFreeService(service: Peer['services'][number]): boolean {
  if (service.paid !== undefined) return !service.paid
  return [service.inputUsdPerMillion, service.outputUsdPerMillion, service.cachedInputUsdPerMillion].every((price) => (price ?? 0) === 0)
}

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

/** A tier drop this close (in weeks) earns a max-lock hint. */
export const DROP_HINT_WEEKS = 4

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
  const outlook = freeTierOutlook(view, pool, program.stakeTiers)
  if (outlook.power <= 0) return null
  const ownStake = pool.positions.some((position) => position.staker.toLowerCase() === view.buyer.toLowerCase())
  if (!outlook.tier) return { text: `Your stake here counts as ${powerAsYearAnts(outlook.power)}, below the first tier.`, dropsSoon: false, ownStake }
  const now = allowance(program, outlook.tier, priced)
  if (outlook.dropsAt === null) {
    return { text: `You get ${now}${freeTierStakeTrend(view, pool).steady ? '; max lock keeps it' : ''}.`, dropsSoon: false, ownStake }
  }
  return {
    text: `You get ${now} until ${shortDate(outlook.dropsAt)}, then ${allowance(program, outlook.tierAfterDrop, priced)}.`,
    dropsSoon: outlook.dropsAt - Date.now() / 1000 <= DROP_HINT_WEEKS * view.epochDuration,
    ownStake,
  }
}

/**
 * "Shrinking weekly until Mar 3, 2027", "Max lock keeps it", "Max lock keeps it
 * until the code expires on <date>", or "Shrinking weekly; the max-locked part holds".
 */
export function stakeTrendLabel(view: FreeTierStake, positions: readonly FreeTierStakePosition[]): string {
  const trend = freeTierStakeTrend(view, { positions })
  if (trend.steady) return 'Max lock keeps it'
  if (!trend.shrinking && trend.endsAt !== null) return `Max lock keeps it until the code expires on ${shortDate(trend.endsAt)}`
  if (trend.endsAt === null) return 'Shrinking weekly; the max-locked part holds'
  return `Shrinking weekly until ${shortDate(trend.endsAt)}`
}

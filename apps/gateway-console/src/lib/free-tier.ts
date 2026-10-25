import type { FreeTierProgramView } from '../api/types'

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

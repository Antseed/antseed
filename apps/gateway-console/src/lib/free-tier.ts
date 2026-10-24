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

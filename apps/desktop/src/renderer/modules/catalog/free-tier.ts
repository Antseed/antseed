import { FREE_TIER_EPOCHS_PER_YEAR, type FreeTierProgram, type FreeTierStakeTier } from '@antseed/node/free-tier-program';

function per(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (hours === 24) return 'a day';
  if (hours >= 1 && Number.isInteger(hours)) return `per ${hours} h`;
  return `per ${Math.max(1, Math.round(windowMs / 60_000))} min`;
}

/** "1,000 free requests a day", from the per-buyer limit (else the per-IP one). */
export function freeTierBaseLabel(program: FreeTierProgram): string | null {
  const { maxRequestsPerAddress, maxRequestsPerIp, windowMs } = program.base;
  const count = maxRequestsPerAddress ?? maxRequestsPerIp;
  if (count === null) return null;
  return `${count.toLocaleString('en-US')} free requests ${per(windowMs)}${maxRequestsPerAddress === null ? ' per IP' : ''}`;
}

/** "10,000 ANTS": what a tier needs locked for a year (power is ANTS × weeks of lock). */
export function tierAnts(tier: FreeTierStakeTier): string {
  return `${Math.ceil(tier.minPower / FREE_TIER_EPOCHS_PER_YEAR).toLocaleString('en-US')} ANTS`;
}

export function tierAllowance(tier: FreeTierStakeTier): string {
  return tier.multiplier === 'unlimited' ? 'Unlimited' : `${tier.multiplier}× the free limit`;
}

/** The first tier above `power` (ANTS-epochs), or null at the top tier. */
export function nextTier(tiers: readonly FreeTierStakeTier[], power: number): FreeTierStakeTier | null {
  return tiers.find((tier) => tier.minPower > power) ?? null;
}

/**
 * The one-line summary of a program on a route: "1,000 free requests a day" or
 * "Free for stakers" on a free model, and on a priced one its free allowance
 * before the listed price applies.
 */
export function freeTierHeadline(program: FreeTierProgram, priced: boolean): string {
  if (program.base.stakersOnly) return priced ? 'Free for stakers, others pay' : 'Free for stakers';
  const base = freeTierBaseLabel(program) ?? 'Free';
  return priced ? `${base}, then paid` : base;
}

/** What a tier allows, in requests: "5,000 a day" or "Unlimited". */
export function tierLimit(program: FreeTierProgram, tier: FreeTierStakeTier): string {
  if (tier.multiplier === 'unlimited') return 'Unlimited';
  const base = program.base.maxRequestsPerAddress ?? program.base.maxRequestsPerIp;
  if (base === null) return tierAllowance(tier);
  return `${(base * tier.multiplier).toLocaleString('en-US')} ${per(program.base.windowMs)}`;
}

/**
 * What a tier allows, from a free-tier refusal: "200 free requests a day"
 * when the seller sent its base limit, else "5× the free limit".
 */
export function refusalTierAllowance(limit: { baseLimit?: number | null; windowMs: number | null }, tier: FreeTierStakeTier): string {
  if (tier.multiplier === 'unlimited') return 'unlimited free use';
  if (limit.baseLimit == null || limit.windowMs === null) return tierAllowance(tier).toLowerCase();
  return `${(limit.baseLimit * tier.multiplier).toLocaleString('en-US')} free requests ${per(limit.windowMs)}`;
}

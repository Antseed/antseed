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

/** Open the staking dashboard on one seller's pool (its agent id). */
export function openSellerPool(agentId: number): void {
  void window.antseedDesktop?.stakingOpen?.({ page: 'stake', pool: agentId });
}

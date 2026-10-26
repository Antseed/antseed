import {
  FREE_TIER_EPOCHS_PER_YEAR,
  freeTierOutlook,
  freeTierStakeTrend,
  type FreeTierPoolStakeView,
  type FreeTierProgram,
  type FreeTierStakeTier,
  type FreeTierStakeView,
} from '@antseed/node/free-tier-program';

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

/** A buyer's counted stake, and the buyer it counts for. */
export type BuyerFreeTierStake = FreeTierStakeView & { buyer: string };

/** A tier drop this close (in weeks) earns a max-lock hint. */
export const FREE_TIER_DROP_HINT_WEEKS = 4;

function shortDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "12,000 ANTS for a year": power (ANTS-epochs) in the units tiers are shown in. */
export function powerAsYearAnts(power: number): string {
  return `${Math.floor(power / FREE_TIER_EPOCHS_PER_YEAR).toLocaleString('en-US')} ANTS for a year`;
}

/** What a tier, or no tier, gives under `program`: "1,000 a day", "unlimited", "no free use". */
function allowance(program: FreeTierProgram, tier: FreeTierStakeTier | null, priced: boolean): string {
  if (tier) return tierLimit(program, tier).replace(/^Unlimited$/, 'unlimited');
  if (program.base.stakersOnly) return priced ? 'the listed price' : 'no free use';
  const base = program.base.maxRequestsPerAddress ?? program.base.maxRequestsPerIp;
  return base === null ? 'the free limit' : `${base.toLocaleString('en-US')} ${per(program.base.windowMs)}`;
}

export interface FreeTierStandingLine {
  text: string;
  /** The tier drops within `FREE_TIER_DROP_HINT_WEEKS`: max lock would keep it. */
  dropsSoon: boolean;
  /** Some of the counted stake is this buyer's own, so it can turn max lock on itself. */
  ownStake: boolean;
}

/**
 * Where this buyer's stake in `agentId`'s pool stands under `program`:
 * "You get 1,000 a day until Dec 14, 2026, then 100 a day". Null without stake there.
 */
export function freeTierStandingLine(
  program: FreeTierProgram,
  view: BuyerFreeTierStake | null,
  agentId: number,
  priced: boolean,
): FreeTierStandingLine | null {
  const pool = view?.pools.find((entry) => entry.agentId === agentId);
  if (!view || !pool) return null;
  const outlook = freeTierOutlook(view, pool, program.stakeTiers);
  if (outlook.power <= 0) return null;
  const ownStake = pool.positions.some((position) => position.staker === view.buyer.toLowerCase());
  if (!outlook.tier) {
    return { text: `Your stake here counts as ${powerAsYearAnts(outlook.power)}, below the first tier.`, dropsSoon: false, ownStake };
  }
  const now = allowance(program, outlook.tier, priced);
  if (outlook.dropsAt === null) {
    const trend = freeTierStakeTrend(view, pool);
    return { text: `You get ${now}${trend.steady ? '; max lock keeps it' : ''}.`, dropsSoon: false, ownStake };
  }
  return {
    text: `You get ${now} until ${shortDate(outlook.dropsAt)}, then ${allowance(program, outlook.tierAfterDrop, priced)}.`,
    dropsSoon: outlook.dropsAt - Date.now() / 1000 <= FREE_TIER_DROP_HINT_WEEKS * view.epochDuration,
    ownStake,
  };
}

/**
 * How one pool's counted stake changes: "Counts as 12,000 ANTS for a year,
 * shrinking weekly until Mar 3, 2027", "…; max lock keeps it", or, for
 * max-locked stake shared by code, "…until the code expires on <date>".
 */
export function freeTierTrendLine(view: FreeTierStakeView, pool: FreeTierPoolStakeView): string {
  const trend = freeTierStakeTrend(view, pool);
  const counts = `Counts as ${powerAsYearAnts(trend.power)}`;
  if (trend.steady) return `${counts}; max lock keeps it`;
  if (!trend.shrinking && trend.endsAt !== null) return `${counts}; max lock keeps it until the code expires on ${shortDate(trend.endsAt)}`;
  if (trend.endsAt === null) return `${counts}, shrinking weekly; the max-locked part holds`;
  return `${counts}, shrinking weekly until ${shortDate(trend.endsAt)}`;
}

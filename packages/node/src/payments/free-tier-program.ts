/**
 * Staked free-tier program: how much more free usage a seller grants buyers
 * who lock ANTS in that seller's pool.
 *
 * Tiers are measured in staking power, the same quantity the seller pool uses
 * for rewards: ANTS amount × epochs of lock remaining (one epoch is a week).
 * Power is zero until a position activates and shrinks as the lock runs down,
 * so a tier rewards long commitments over short-lived stake.
 *
 * Sellers advertise the program in their signed peer metadata as capability
 * strings, so buyers and indexers can read it without a metadata version bump:
 *
 *   free-tier.v1.base[.a<perAddress>][.i<perIp>].w<windowMs>
 *   free-tier.v1.tier.p<minPower>.x<multiplier>      (x0 = unlimited)
 */

/** One staked tier. `minPower` is in ANTS-epochs (whole ANTS × epochs of lock remaining). */
export interface FreeTierStakeTier {
  minPower: number;
  /** Multiplier on the base allowance, or `'unlimited'`. */
  multiplier: number | 'unlimited';
}

export interface FreeTierBaseLimits {
  maxRequestsPerAddress: number | null;
  maxRequestsPerIp: number | null;
  windowMs: number;
}

export interface FreeTierProgram {
  base: FreeTierBaseLimits;
  stakeTiers: FreeTierStakeTier[];
}

/** Epochs in one year of lock; tiers are documented as "ANTS locked for a year". */
export const FREE_TIER_EPOCHS_PER_YEAR = 52;

/**
 * Network default: 10k / 50k / 200k ANTS locked for a year earn 5×, 20× and
 * unlimited free usage on the seller they are staked on.
 */
export const DEFAULT_FREE_TIER_STAKE_TIERS: readonly FreeTierStakeTier[] = Object.freeze([
  { minPower: 10_000 * FREE_TIER_EPOCHS_PER_YEAR, multiplier: 5 },
  { minPower: 50_000 * FREE_TIER_EPOCHS_PER_YEAR, multiplier: 20 },
  { minPower: 200_000 * FREE_TIER_EPOCHS_PER_YEAR, multiplier: 'unlimited' },
]);

export const MAX_FREE_TIER_STAKE_TIERS = 4;
export const MAX_FREE_TIER_MULTIPLIER = 10_000;

const CAPABILITY_PREFIX = 'free-tier.v1.';
const BASE_CAPABILITY_PREFIX = `${CAPABILITY_PREFIX}base`;
const TIER_CAPABILITY_PREFIX = `${CAPABILITY_PREFIX}tier`;
const ANTS_WEI = 10n ** 18n;

/** Throws when `tiers` is not a valid program: increasing power, increasing multipliers, unlimited last. */
export function validateFreeTierStakeTiers(tiers: readonly FreeTierStakeTier[], label = 'freeTier.stakeTiers'): void {
  if (tiers.length > MAX_FREE_TIER_STAKE_TIERS) {
    throw new Error(`${label} accepts at most ${MAX_FREE_TIER_STAKE_TIERS} tiers`);
  }
  let previousPower = 0;
  let previousMultiplier = 1;
  let sawUnlimited = false;
  tiers.forEach((tier, index) => {
    const at = `${label}[${index}]`;
    if (!Number.isSafeInteger(tier.minPower) || tier.minPower < 1) {
      throw new Error(`${at}.minPower must be a positive safe integer`);
    }
    if (tier.minPower <= previousPower) {
      throw new Error(`${at}.minPower must be greater than the previous tier`);
    }
    if (sawUnlimited) {
      throw new Error(`${at} follows an unlimited tier`);
    }
    if (tier.multiplier === 'unlimited') {
      sawUnlimited = true;
    } else if (
      !Number.isSafeInteger(tier.multiplier)
      || tier.multiplier <= previousMultiplier
      || tier.multiplier > MAX_FREE_TIER_MULTIPLIER
    ) {
      throw new Error(`${at}.multiplier must be an integer above the previous tier (minimum 2, maximum ${MAX_FREE_TIER_MULTIPLIER}) or "unlimited"`);
    } else {
      previousMultiplier = tier.multiplier;
    }
    previousPower = tier.minPower;
  });
}

/** Highest tier `power` (raw on-chain power: ANTS wei × epochs) qualifies for, or null. */
export function freeTierStakeTierForPower(
  tiers: readonly FreeTierStakeTier[],
  power: bigint,
): FreeTierStakeTier | null {
  let match: FreeTierStakeTier | null = null;
  for (const tier of tiers) {
    if (power >= BigInt(tier.minPower) * ANTS_WEI) match = tier;
  }
  return match;
}

/** Raw on-chain power (ANTS wei × epochs) as whole ANTS-epochs. */
export function powerToAntsEpochs(power: bigint): number {
  const whole = power / ANTS_WEI;
  return whole > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(whole);
}

/** Capability strings advertising `program` in peer metadata. */
export function encodeFreeTierCapabilities(program: FreeTierProgram): string[] {
  const { base } = program;
  const baseParts = [
    BASE_CAPABILITY_PREFIX,
    ...(base.maxRequestsPerAddress !== null ? [`a${base.maxRequestsPerAddress}`] : []),
    ...(base.maxRequestsPerIp !== null ? [`i${base.maxRequestsPerIp}`] : []),
    `w${base.windowMs}`,
  ];
  return [
    baseParts.join('.'),
    ...program.stakeTiers.map((tier) =>
      `${TIER_CAPABILITY_PREFIX}.p${tier.minPower}.x${tier.multiplier === 'unlimited' ? 0 : tier.multiplier}`),
  ];
}

/**
 * Read a seller's free-tier program from its advertised capabilities.
 * Returns null when the seller advertises none or the strings are malformed.
 */
export function parseFreeTierProgram(capabilities: readonly string[] | undefined): FreeTierProgram | null {
  if (!capabilities) return null;
  let base: FreeTierBaseLimits | null = null;
  const stakeTiers: FreeTierStakeTier[] = [];
  for (const capability of capabilities) {
    if (!capability.startsWith(CAPABILITY_PREFIX)) continue;
    const [, , kind, ...fields] = capability.split('.');
    const values = new Map<string, number>();
    for (const field of fields) {
      const match = /^([a-z])(\d{1,16})$/.exec(field);
      if (!match) return null;
      const value = Number(match[2]);
      if (!Number.isSafeInteger(value)) return null;
      values.set(match[1]!, value);
    }
    if (kind === 'base') {
      const windowMs = values.get('w');
      if (windowMs === undefined || windowMs < 1_000) return null;
      base = {
        maxRequestsPerAddress: values.get('a') ?? null,
        maxRequestsPerIp: values.get('i') ?? null,
        windowMs,
      };
    } else if (kind === 'tier') {
      const minPower = values.get('p');
      const multiplier = values.get('x');
      if (minPower === undefined || multiplier === undefined) return null;
      stakeTiers.push({ minPower, multiplier: multiplier === 0 ? 'unlimited' : multiplier });
    }
  }
  if (!base) return null;
  stakeTiers.sort((a, b) => a.minPower - b.minPower);
  try {
    validateFreeTierStakeTiers(stakeTiers);
  } catch {
    return null;
  }
  return { base, stakeTiers };
}

/**
 * A free-tier program passed on as JSON (by a buyer's catalog), validated the
 * same way as advertised capabilities. Returns null when it is not one.
 */
export function normalizeFreeTierProgram(value: unknown): FreeTierProgram | null {
  if (!value || typeof value !== 'object') return null;
  const { base, stakeTiers } = value as Partial<Record<keyof FreeTierProgram, unknown>>;
  if (!base || typeof base !== 'object' || !Array.isArray(stakeTiers)) return null;
  const limits = base as Record<string, unknown>;
  const count = (field: unknown): number | null | undefined =>
    field === null || field === undefined ? null : Number.isSafeInteger(field) && (field as number) >= 0 ? field as number : undefined;
  const maxRequestsPerAddress = count(limits.maxRequestsPerAddress);
  const maxRequestsPerIp = count(limits.maxRequestsPerIp);
  const windowMs = count(limits.windowMs);
  if (maxRequestsPerAddress === undefined || maxRequestsPerIp === undefined || !windowMs) return null;
  const tiers = stakeTiers.map((tier) => tier as Partial<FreeTierStakeTier>);
  if (tiers.some((tier) => !tier || typeof tier.minPower !== 'number' || (tier.multiplier !== 'unlimited' && typeof tier.multiplier !== 'number'))) return null;
  return parseFreeTierProgram(encodeFreeTierCapabilities({
    base: { maxRequestsPerAddress, maxRequestsPerIp, windowMs },
    stakeTiers: tiers as FreeTierStakeTier[],
  }));
}

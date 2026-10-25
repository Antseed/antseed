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
 *   free-tier.v1.base[.a<perAddress>][.i<perIp>].w<windowMs>[.s1][.t1]
 *   free-tier.v1.tier.p<minPower>.x<multiplier>                   (x0 = unlimited)
 *
 * A service with its own program advertises the same strings scoped by
 * `m<first 8 hex of keccak256(serviceId)>` after the version, e.g.
 * `free-tier.v1.m1a2b3c4d.base.a10.w86400000.s1`. Services without one fall
 * back to the unscoped, seller-wide program.
 *
 * `s1` marks a stakers-only program. `t1` on a scoped base means the program
 * uses the seller-wide tiers, so it costs one capability string, not five.
 *
 * On a priced service, its own program is a free allowance: requests it covers
 * are free, the rest are paid. The seller-wide program covers free services only.
 */
import { id } from 'ethers';


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
  /**
   * Only buyers whose stake reaches a tier are served; the base limits are
   * then just the unit the tier multipliers apply to.
   */
  stakersOnly?: boolean;
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

/**
 * Response header a seller sets, to `FREE_TIER_SERVED_COVERED`, on a request
 * to a priced service that the service's free allowance covered: the buyer
 * owes nothing for it. A buyer that ignores it pays the listed price.
 */
export const FREE_TIER_SERVED_HEADER = 'x-antseed-free-tier';
export const FREE_TIER_SERVED_COVERED = 'covered';

export const MAX_FREE_TIER_STAKE_TIERS = 4;
export const MAX_FREE_TIER_MULTIPLIER = 10_000;

const CAPABILITY_PREFIX = 'free-tier.v1.';
const ANTS_WEI = 10n ** 18n;
const SCOPE_PATTERN = /^m[0-9a-f]{8}$/;

/** Capability scope of a service's own program: `m` + the first 8 hex of keccak256(serviceId). */
export function freeTierServiceScope(serviceId: string): string {
  return `m${id(serviceId).slice(2, 10)}`;
}

/** Throws when `tiers` is not a valid program: increasing power, increasing multipliers, unlimited last. */
export function validateFreeTierStakeTiers(tiers: readonly FreeTierStakeTier[], label = 'freeTier.stakeTiers'): void {
  if (tiers.length > MAX_FREE_TIER_STAKE_TIERS) {
    throw new Error(`${label} accepts at most ${MAX_FREE_TIER_STAKE_TIERS} tiers`);
  }
  let previousPower = 0;
  // A first tier may be 1x: on a stakers-only program it grants the base limits.
  let previousMultiplier = 0;
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
      throw new Error(`${at}.multiplier must be an integer above the previous tier (minimum 1, maximum ${MAX_FREE_TIER_MULTIPLIER}) or "unlimited"`);
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

/**
 * Capability strings advertising `program` in peer metadata: the seller-wide
 * program, or `serviceId`'s own program when given.
 */
export function encodeFreeTierCapabilities(
  program: FreeTierProgram,
  serviceId?: string,
  options: { sellerWideTiers?: readonly FreeTierStakeTier[] } = {},
): string[] {
  const { base } = program;
  const inheritTiers = serviceId !== undefined
    && options.sellerWideTiers !== undefined
    && program.stakeTiers.length > 0
    && sameStakeTiers(program.stakeTiers, options.sellerWideTiers);
  const prefix = serviceId === undefined ? CAPABILITY_PREFIX : `${CAPABILITY_PREFIX}${freeTierServiceScope(serviceId)}.`;
  const baseParts = [
    `${prefix}base`,
    ...(base.maxRequestsPerAddress !== null ? [`a${base.maxRequestsPerAddress}`] : []),
    ...(base.maxRequestsPerIp !== null ? [`i${base.maxRequestsPerIp}`] : []),
    `w${base.windowMs}`,
    ...(base.stakersOnly ? ['s1'] : []),
    ...(inheritTiers ? ['t1'] : []),
  ];
  return [
    baseParts.join('.'),
    ...(inheritTiers ? [] : program.stakeTiers).map((tier) =>
      `${prefix}tier.p${tier.minPower}.x${tier.multiplier === 'unlimited' ? 0 : tier.multiplier}`),
  ];
}

/**
 * Read a seller's free-tier program from its advertised capabilities: the
 * program `serviceId` is served under when given (its own, else the
 * seller-wide one), otherwise the seller-wide program. Returns null when there
 * is none or its strings are malformed.
 */
export function parseFreeTierProgram(
  capabilities: readonly string[] | undefined,
  serviceId?: string,
): FreeTierProgram | null {
  if (!capabilities) return null;
  if (serviceId !== undefined) {
    const scope = freeTierServiceScope(serviceId);
    if (capabilities.some((capability) => capability.startsWith(`${CAPABILITY_PREFIX}${scope}.`))) {
      return parseScopedFreeTierProgram(capabilities, scope);
    }
  }
  return parseScopedFreeTierProgram(capabilities, null);
}

/** A service's advertised prices, as the free tier classifies them. */
export interface FreeTierServicePrices {
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
  cachedInputUsdPerMillion?: number | null;
  maxImageUsdPerImage?: number | null;
  /** Unit-billing models by API protocol (images, video, per-request fees). */
  unitBillingModels?: Record<string, { components?: ReadonlyArray<{ priceUsd: number }> } | undefined> | null;
}

/**
 * Whether a service charges anything, the way the seller decides it: any
 * token price, image price or priced unit-billing component makes it paid.
 */
export function isPricedService(prices: FreeTierServicePrices): boolean {
  const positive = (value: number | null | undefined) => typeof value === 'number' && value > 0;
  if (positive(prices.inputUsdPerMillion) || positive(prices.outputUsdPerMillion)
    || positive(prices.cachedInputUsdPerMillion) || positive(prices.maxImageUsdPerImage)) return true;
  return Object.values(prices.unitBillingModels ?? {}).some((model) =>
    (model?.components ?? []).some((component) => !(component.priceUsd <= 0)));
}

/**
 * The program a buyer of `serviceId` is served under: on a free service its
 * own or the seller-wide one, on a priced service only its own free allowance.
 * Paid video is never covered (it is paid through one-off channels), so it has none.
 */
export function freeTierProgramForService(
  capabilities: readonly string[] | undefined,
  serviceId: string,
  priced: boolean,
  options: { video?: boolean } = {},
): FreeTierProgram | null {
  if (!priced) return parseFreeTierProgram(capabilities, serviceId);
  return options.video ? null : parseServiceFreeTierProgram(capabilities, serviceId);
}

/**
 * Only `serviceId`'s own program, never the seller-wide fallback. A priced
 * service's free allowance is always its own program, so this is the one to
 * read for a paid service.
 */
export function parseServiceFreeTierProgram(
  capabilities: readonly string[] | undefined,
  serviceId: string,
): FreeTierProgram | null {
  if (!capabilities) return null;
  const scope = freeTierServiceScope(serviceId);
  if (!capabilities.some((capability) => capability.startsWith(`${CAPABILITY_PREFIX}${scope}.`))) return null;
  return parseScopedFreeTierProgram(capabilities, scope);
}

function sameStakeTiers(a: readonly FreeTierStakeTier[], b: readonly FreeTierStakeTier[]): boolean {
  return a.length === b.length && a.every((tier, index) =>
    tier.minPower === b[index]!.minPower && tier.multiplier === b[index]!.multiplier);
}

function parseScopedFreeTierProgram(capabilities: readonly string[], scope: string | null): FreeTierProgram | null {
  let base: FreeTierBaseLimits | null = null;
  let inheritTiers = false;
  const stakeTiers: FreeTierStakeTier[] = [];
  for (const capability of capabilities) {
    if (!capability.startsWith(CAPABILITY_PREFIX)) continue;
    const parts = capability.split('.');
    const capabilityScope = SCOPE_PATTERN.test(parts[2] ?? '') ? parts[2]! : null;
    if (capabilityScope !== scope) continue;
    const [kind, ...fields] = parts.slice(capabilityScope === null ? 2 : 3);
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
        ...(values.get('s') === 1 ? { stakersOnly: true } : {}),
      };
      inheritTiers = scope !== null && values.get('t') === 1;
    } else if (kind === 'tier') {
      const minPower = values.get('p');
      const multiplier = values.get('x');
      if (minPower === undefined || multiplier === undefined) return null;
      stakeTiers.push({ minPower, multiplier: multiplier === 0 ? 'unlimited' : multiplier });
    }
  }
  if (!base) return null;
  if (inheritTiers) {
    const sellerWide = parseScopedFreeTierProgram(capabilities, null);
    if (!sellerWide) return null;
    stakeTiers.push(...sellerWide.stakeTiers);
  }
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
    base: { maxRequestsPerAddress, maxRequestsPerIp, windowMs, ...(limits.stakersOnly === true ? { stakersOnly: true } : {}) },
    stakeTiers: tiers as FreeTierStakeTier[],
  }));
}

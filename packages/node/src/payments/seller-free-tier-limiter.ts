import { isIP } from 'node:net';
import {
  evaluateFreeTierLimits,
  type FreeTierConsumption,
  type FreeTierLimitCheck,
  type MeteringStorage,
} from '../metering/storage.js';
import { peerIdToAddress } from '../types/peer.js';
import {
  DEFAULT_FREE_TIER_STAKE_TIERS,
  encodeFreeTierCapabilities,
  freeTierStakeTierForPower,
  validateFreeTierStakeTiers,
  type FreeTierProgram,
  type FreeTierStakeTier,
} from './free-tier-program.js';
import type { FreeTierStakeResolver, FreeTierStakeStanding } from './free-tier-stake-resolver.js';
import {
  decodeFreeTierDelegationsHeader,
  verifyFreeTierDelegations,
  type VerifiedFreeTierDelegation,
} from './free-tier-delegation.js';

/** One free-tier program: base limits and the staked tiers above them. */
export interface SellerFreeTierProgramConfig {
  /** Maximum zero-priced requests accepted from one buyer address per window. */
  maxRequestsPerAddress?: number;
  /** Maximum zero-priced requests accepted from one remote IP per window. */
  maxRequestsPerIp?: number;
  /** Sliding-window duration in milliseconds. Default: 24 hours. */
  windowMs?: number;
  /**
   * Larger allowances for buyers staked on this seller, by staking power.
   * Default: `DEFAULT_FREE_TIER_STAKE_TIERS`. `[]` turns staked tiers off.
   */
  stakeTiers?: FreeTierStakeTier[];
  /**
   * Serve only buyers whose stake reaches a tier. The base limits are still
   * required: they are the allowance the tier multipliers apply to.
   */
  stakersOnly?: boolean;
}

export interface SellerFreeTierConfig extends SellerFreeTierProgramConfig {
  /**
   * Programs for individual services, keyed by announced service id. A listed
   * service uses only its own program and its own counters; the other
   * zero-priced services use the seller-wide program above, or are not limited
   * when there is none. On a priced service the program is a free allowance:
   * requests it covers are served free, and the rest are paid as usual.
   */
  services?: Record<string, SellerFreeTierProgramConfig>;
}

export interface FreeTierDecision extends FreeTierConsumption {
  buyerAddress: string;
  /** Normalized remote IP the decision was keyed on, or null when unknown. */
  remoteIp: string | null;
  /** Staked standing the decision used, or null for the base limits. */
  standing: FreeTierStakeStanding | null;
  /** Tier the standing earned under this program, or null for the base limits. */
  tier: FreeTierStakeTier | null;
  /** Limit that applied to the binding counter; null when unlimited. */
  limit: number | null;
  /** The program the request was decided under, as advertised. */
  program: FreeTierProgram;
}

export interface FreeTierConsumeInput {
  buyerPeerId: string;
  service: string;
  /** Raw socket remote address of the buyer connection, if known. */
  remoteIp?: string | null;
  /** Staked standing from `resolveStanding`; omitted or null applies the base limits. */
  standing?: FreeTierStakeStanding | null;
  /** The service is priced: only its own program applies, never the seller-wide one. */
  paid?: boolean;
  nowMs?: number;
}

export const DEFAULT_FREE_TIER_WINDOW_MS = 24 * 60 * 60_000;
const MAX_IN_MEMORY_KEYS = 20_000;

/**
 * Normalize a socket remote address into a limiter key.
 * IPv4-mapped IPv6 addresses collapse to plain IPv4; IPv6 is grouped by /64 so a
 * single host cannot hop across its own prefix to reset the counter.
 */
export function normalizeRemoteIp(remoteIp: string | null | undefined): string | null {
  if (!remoteIp) return null;
  let ip = remoteIp.trim();
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex !== -1) ip = ip.slice(0, zoneIndex);
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(ip);
  if (mapped) ip = mapped[1]!;
  const version = isIP(ip);
  if (version === 4) return ip;
  if (version !== 6) return null;
  const expanded = expandIpv6(ip);
  if (!expanded) return null;
  return `${expanded.slice(0, 4).join(':')}::/64`;
}

function expandIpv6(ip: string): string[] | null {
  const [head, tail] = ip.toLowerCase().split('::');
  const headParts = head ? head.split(':') : [];
  const tailParts = tail ? tail.split(':') : [];
  const isCompressed = tail !== undefined;
  const missing = 8 - headParts.length - tailParts.length;
  if (isCompressed ? missing < 0 : missing !== 0) return null;
  const zeros = isCompressed ? Array<string>(missing).fill('0') : [];
  return [...headParts, ...zeros, ...tailParts].map((part) => part.padStart(4, '0'));
}

/** One validated program and the counter scope it is accounted under. */
class FreeTierPolicy {
  readonly maxRequestsPerAddress: number | null;
  readonly maxRequestsPerIp: number | null;
  readonly windowMs: number;
  readonly stakeTiers: readonly FreeTierStakeTier[];
  readonly stakersOnly: boolean;

  constructor(readonly scope: string, config: SellerFreeTierProgramConfig, label: string) {
    const perAddress = config.maxRequestsPerAddress;
    const perIp = config.maxRequestsPerIp;
    if (perAddress !== undefined && (!Number.isSafeInteger(perAddress) || perAddress < 1)) {
      throw new Error(`${label}.maxRequestsPerAddress must be a positive safe integer`);
    }
    if (perIp !== undefined && (!Number.isSafeInteger(perIp) || perIp < 1)) {
      throw new Error(`${label}.maxRequestsPerIp must be a positive safe integer`);
    }
    if (perAddress === undefined && perIp === undefined) {
      throw new Error(`${label} requires maxRequestsPerAddress and/or maxRequestsPerIp`);
    }
    const windowMs = config.windowMs ?? DEFAULT_FREE_TIER_WINDOW_MS;
    if (!Number.isSafeInteger(windowMs) || windowMs < 1_000) {
      throw new Error(`${label}.windowMs must be a safe integer of at least 1000`);
    }
    const stakeTiers = config.stakeTiers ?? DEFAULT_FREE_TIER_STAKE_TIERS;
    validateFreeTierStakeTiers(stakeTiers, `${label}.stakeTiers`);
    if (config.stakersOnly && stakeTiers.length === 0) {
      throw new Error(`${label}.stakersOnly requires at least one stake tier`);
    }
    this.maxRequestsPerAddress = perAddress ?? null;
    this.maxRequestsPerIp = perIp ?? null;
    this.windowMs = windowMs;
    this.stakeTiers = Object.freeze([...stakeTiers]);
    this.stakersOnly = config.stakersOnly === true;
  }

  program(tiersActive: boolean): FreeTierProgram {
    return {
      base: {
        maxRequestsPerAddress: this.maxRequestsPerAddress,
        maxRequestsPerIp: this.maxRequestsPerIp,
        windowMs: this.windowMs,
        ...(this.stakersOnly ? { stakersOnly: true } : {}),
      },
      stakeTiers: tiersActive ? [...this.stakeTiers] : [],
    };
  }

  /** Requests per window a staked tier allows, or null when unlimited. */
  limitForTier(tier: FreeTierStakeTier): number | null {
    if (tier.multiplier === 'unlimited') return null;
    const base = this.maxRequestsPerAddress ?? this.maxRequestsPerIp!;
    return Math.min(Number.MAX_SAFE_INTEGER, base * tier.multiplier);
  }

  /**
   * "free requests a day: 100 per buyer address, then paid; staked (a day):
   * 1,000,000 power → 1,000, 10,000,000 power → unlimited". `paid`: the service is priced.
   */
  describe(paid = false): string {
    const window = describeWindow(this.windowMs);
    const parts: string[] = [];
    if (this.maxRequestsPerAddress !== null) parts.push(`${count(this.maxRequestsPerAddress)} per buyer address`);
    if (this.maxRequestsPerIp !== null) parts.push(`${count(this.maxRequestsPerIp)} per IP`);
    const head = this.stakersOnly
      ? `free only for stakers${paid ? ', others pay' : ', others are refused'}`
      : `free requests ${window}: ${parts.join(', ')}${paid ? ', then paid' : ''}`;
    const tiers = this.stakeTiers.map((tier) => {
      const limit = this.limitForTier(tier);
      return `${count(tier.minPower)} power → ${limit === null ? 'unlimited' : count(limit)}`;
    });
    return tiers.length > 0 ? `${head}; staked (${window}): ${tiers.join(', ')}` : head;
  }
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

function describeWindow(windowMs: number): string {
  const hours = windowMs / 3_600_000;
  if (hours === 24) return 'a day';
  if (hours >= 1 && Number.isInteger(hours)) return `per ${hours} h`;
  return windowMs % 60_000 === 0 ? `per ${windowMs / 60_000} min` : `per ${windowMs / 1000} s`;
}

function hasSellerWideProgram(config: SellerFreeTierConfig): boolean {
  return config.maxRequestsPerAddress !== undefined
    || config.maxRequestsPerIp !== undefined
    || config.windowMs !== undefined
    || config.stakeTiers !== undefined
    || config.stakersOnly !== undefined;
}

export class SellerFreeTierLimiter {
  private readonly _default: FreeTierPolicy | null;
  private readonly _services: ReadonlyMap<string, FreeTierPolicy>;
  /** Longest window of any program: usage younger than this is never pruned. */
  private readonly _retentionMs: number;
  private readonly _storage: MeteringStorage | null;
  private readonly _inMemoryUsage = new Map<string, number[]>();
  private _stakeResolver: FreeTierStakeResolver | null = null;
  private _chainId = 0;
  /** Last verified delegations per buyer address, in insertion order for eviction. */
  private readonly _delegations = new Map<string, VerifiedFreeTierDelegation[]>();
  /** Priced services, whose allowances never admit a free-usage channel. */
  private _paidServices: ReadonlySet<string> = new Set();
  /** Zero-priced services this seller offers, or null when not told: they decide channel admission. */
  private _freeServices: readonly string[] | null = null;

  constructor(config: SellerFreeTierConfig, storage: MeteringStorage | null = null) {
    const services = Object.entries(config.services ?? {});
    if (!hasSellerWideProgram(config) && services.length === 0) {
      throw new Error('freeTier requires maxRequestsPerAddress and/or maxRequestsPerIp');
    }
    this._default = hasSellerWideProgram(config) ? new FreeTierPolicy('', config, 'freeTier') : null;
    this._services = new Map(services.map(([service, program]) => {
      if (service.length === 0) throw new Error('freeTier.services keys must be non-empty service ids');
      return [service, new FreeTierPolicy(service, program, `freeTier.services.${service}`)];
    }));
    this._retentionMs = Math.max(...this._policies().map((policy) => policy.windowMs));
    this._storage = storage;
  }

  /**
   * Enable staked tiers. Without a resolver every buyer gets the base limits.
   * `chainId` is the EIP-712 domain delegations are verified against.
   */
  setStakeResolver(resolver: FreeTierStakeResolver | null, chainId = 0): void {
    this._stakeResolver = resolver;
    this._chainId = chainId;
  }

  /** Whether any program has staked tiers, so stake lookups are worth enabling. */
  get hasStakeTiers(): boolean {
    return this._policies().some((policy) => policy.stakeTiers.length > 0);
  }

  /** Whether staked tiers are live: configured and backed by on-chain reads. */
  get stakeTiersActive(): boolean {
    return this._stakeResolver !== null && this.hasStakeTiers;
  }

  /**
   * Whether a program applies to `service`: its own, or for a zero-priced
   * service the seller-wide one. A priced service has one only when configured.
   */
  appliesTo(service: string, options: { paid?: boolean } = {}): boolean {
    return this._policyFor(service, options.paid === true) !== null;
  }

  /**
   * Services that are priced. Their programs are free allowances on paid
   * models, served without a free-usage channel, so channel admission ignores them.
   */
  setPaidServices(services: Iterable<string>): void {
    this._paidServices = new Set(services);
  }

  /** The zero-priced services this seller offers, so channel admission checks exactly their programs. */
  setFreeServices(services: Iterable<string>): void {
    this._freeServices = [...new Set(services)];
  }

  /**
   * The program `service` is served under, or the seller-wide program when
   * `service` is omitted; tiers only when they are enforced. Null when none applies.
   */
  program(service?: string, options: { paid?: boolean } = {}): FreeTierProgram | null {
    const policy = service === undefined ? this._default : this._policyFor(service, options.paid === true);
    return policy?.program(this.stakeTiersActive) ?? null;
  }

  /**
   * Peer-metadata capability strings advertising every program: the
   * seller-wide one first, then services in id order. A program that would
   * exceed `budget` strings is skipped whole, never advertised in part.
   */
  capabilities(budget = Number.POSITIVE_INFINITY): string[] {
    const active = this.stakeTiersActive;
    const out: string[] = [];
    const programs: Array<[string | undefined, FreeTierPolicy]> = [
      ...(this._default ? [[undefined, this._default] as [undefined, FreeTierPolicy]] : []),
      ...[...this._services].sort(([a], [b]) => a.localeCompare(b)),
    ];
    // Service programs may point at the seller-wide tiers only once those are advertised.
    let sellerWideTiers: FreeTierStakeTier[] | undefined;
    for (const [service, policy] of programs) {
      const strings = encodeFreeTierCapabilities(policy.program(active), service, sellerWideTiers ? { sellerWideTiers } : {});
      if (out.length + strings.length > budget) continue;
      out.push(...strings);
      if (service === undefined) sellerWideTiers = policy.program(active).stakeTiers;
    }
    return out;
  }

  /**
   * Staked standing for this buyer, or null for the base limits. Never throws.
   *
   * `delegationsHeader` is the buyer's `x-antseed-free-tier-delegations`
   * value, or '' when a request carried none. Verified stakers are
   * remembered for the buyer, so channel-open admission, which passes
   * undefined because it carries no request headers, sees the same standing.
   */
  async resolveStanding(buyerPeerId: string, delegationsHeader?: string): Promise<FreeTierStakeStanding | null> {
    if (!this._stakeResolver || !this.hasStakeTiers) return null;
    const buyer = peerIdToAddress(buyerPeerId).toLowerCase();
    if (delegationsHeader !== undefined) {
      const delegations = decodeFreeTierDelegationsHeader(delegationsHeader, buyer);
      this._rememberDelegations(buyer, verifyFreeTierDelegations(delegations, buyer, this._chainId));
    }
    const nowSeconds = Date.now() / 1000;
    const stakers = (this._delegations.get(buyer) ?? [])
      .filter((delegation) => delegation.expiresAt > nowSeconds)
      .map((delegation) => delegation.staker);
    return this._stakeResolver.resolve(buyer, stakers);
  }

  private _rememberDelegations(buyer: string, delegations: VerifiedFreeTierDelegation[]): void {
    this._delegations.delete(buyer);
    if (delegations.length === 0) return;
    if (this._delegations.size >= MAX_IN_MEMORY_KEYS) {
      const oldest = this._delegations.keys().next().value;
      if (oldest !== undefined) this._delegations.delete(oldest);
    }
    this._delegations.set(buyer, delegations);
  }

  /**
   * One line per program: the seller-wide one for free models, then each
   * service's own. A priced service's line is its free allowance before its
   * price applies, as set by `setPaidServices`.
   */
  describePrograms(): string[] {
    const lines = this._default ? [`free models: ${this._default.describe()}`] : [];
    for (const [service, policy] of this._services) {
      lines.push(`${service}: ${policy.describe(this._paidServices.has(service))}`);
    }
    return lines;
  }

  describe(): string {
    return this.describePrograms().join(' | ');
  }

  /** Consume one request for `input.service`. Callers check `appliesTo` first. */
  consume(input: FreeTierConsumeInput): FreeTierDecision {
    const policy = this._policyFor(input.service, input.paid === true);
    if (!policy) throw new Error(`no free-tier program applies to ${input.service}`);
    return this._evaluate(policy, input, input.service);
  }

  /**
   * Check channel-open admission without consuming an inference request.
   * The channel serves every free service, so it is admitted when the program
   * of some offered free service would still serve the buyer, or when one of
   * them is not limited at all. Otherwise the first refusal (the seller-wide
   * one when it applies) is reported. Without the offered services (see
   * `setFreeServices`), every program of a zero-priced service is considered,
   * and no seller-wide program means some free service is unlimited.
   */
  check(input: Omit<FreeTierConsumeInput, 'service' | 'paid'>): FreeTierDecision | null {
    let policies: FreeTierPolicy[];
    if (this._freeServices) {
      const applicable = this._freeServices.map((service) => this._policyFor(service, false));
      if (applicable.length === 0 || applicable.some((policy) => policy === null)) return null;
      policies = [...new Set(applicable as FreeTierPolicy[])]
        .sort((a, b) => (a === this._default ? -1 : b === this._default ? 1 : 0));
    } else {
      if (!this._default) return null;
      policies = this._policies().filter((policy) => !this._paidServices.has(policy.scope));
    }
    const decisions = policies.map((policy) => this._evaluate(policy, input, null));
    return decisions.find((decision) => decision.allowed) ?? decisions[0]!;
  }

  private _policies(): FreeTierPolicy[] {
    return [...(this._default ? [this._default] : []), ...this._services.values()];
  }

  private _policyFor(service: string, paid: boolean): FreeTierPolicy | null {
    return this._services.get(service) ?? (paid ? null : this._default);
  }

  private _evaluate(
    policy: FreeTierPolicy,
    input: Omit<FreeTierConsumeInput, 'service'>,
    service: string | null,
  ): FreeTierDecision {
    const nowMs = input.nowMs ?? Date.now();
    const buyerAddress = peerIdToAddress(input.buyerPeerId).toLowerCase();
    const remoteIp = normalizeRemoteIp(input.remoteIp);
    const program = policy.program(this.stakeTiersActive);
    // A standing below this program's lowest tier gets the base limits.
    const tier = input.standing ? freeTierStakeTierForPower(policy.stakeTiers, input.standing.power) : null;
    const standing = tier ? input.standing! : null;
    if (policy.stakersOnly && !tier) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: 0,
        limitedBy: 'stake_required',
        buyerAddress,
        remoteIp,
        standing: input.standing ?? null,
        tier: null,
        limit: 0,
        program,
      };
    }
    const ownerLimit = tier ? policy.limitForTier(tier) : null;
    const usage = {
      buyerAddress,
      remoteIp,
      maxRequestsPerAddress: policy.maxRequestsPerAddress,
      maxRequestsPerIp: policy.maxRequestsPerIp,
      windowMs: policy.windowMs,
      retentionMs: this._retentionMs,
      scope: policy.scope,
      nowMs,
      stake: standing ? { positionIds: standing.positionIds, limit: ownerLimit } : null,
    };
    const decision = this._storage
      ? (service === null
        ? this._storage.checkFreeTierRequest(usage)
        : this._storage.consumeFreeTierRequest({ ...usage, service }))
      : this._evaluateInMemory(policy, buyerAddress, remoteIp, standing, ownerLimit, nowMs, service !== null);
    return {
      ...decision,
      buyerAddress,
      remoteIp,
      standing,
      tier,
      limit: this._bindingLimit(policy, decision, standing, ownerLimit),
      program,
    };
  }

  private _bindingLimit(
    policy: FreeTierPolicy,
    decision: FreeTierConsumption,
    standing: FreeTierStakeStanding | null,
    ownerLimit: number | null,
  ): number | null {
    if (standing) return ownerLimit;
    if (decision.limitedBy === 'ip') return policy.maxRequestsPerIp;
    return policy.maxRequestsPerAddress ?? policy.maxRequestsPerIp;
  }

  private _evaluateInMemory(
    policy: FreeTierPolicy,
    buyerAddress: string,
    remoteIp: string | null,
    standing: FreeTierStakeStanding | null,
    ownerLimit: number | null,
    nowMs: number,
    consume: boolean,
  ): FreeTierConsumption {
    const windowStart = nowMs - policy.windowMs;
    const buckets = new Map<string, number[]>();
    const checks: FreeTierLimitCheck[] = [];
    const track = (kind: FreeTierLimitCheck['kind'], key: string, limit: number): void => {
      const scopedKey = `${policy.scope}|${key}`;
      const timestamps = (this._inMemoryUsage.get(scopedKey) ?? []).filter((timestamp) => timestamp >= windowStart);
      buckets.set(scopedKey, timestamps);
      checks.push({ kind, limit, count: timestamps.length, oldestTimestamp: timestamps[0] ?? null });
    };
    if (standing) {
      // Unlimited stake is not tracked: nothing would ever read the bucket.
      if (ownerLimit !== null) {
        for (const positionId of standing.positionIds) track('stake', `position:${positionId}`, ownerLimit);
      }
    } else {
      if (policy.maxRequestsPerAddress !== null) track('address', `address:${buyerAddress}`, policy.maxRequestsPerAddress);
      if (policy.maxRequestsPerIp !== null && remoteIp !== null) track('ip', `ip:${remoteIp}`, policy.maxRequestsPerIp);
    }

    const decision = evaluateFreeTierLimits(checks, policy.windowMs, nowMs);
    if (decision.allowed && consume) {
      this._pruneExpiredBuckets(nowMs - this._retentionMs);
      const newKeys = [...buckets.keys()].filter((key) => !this._inMemoryUsage.has(key)).length;
      if (this._inMemoryUsage.size + newKeys > MAX_IN_MEMORY_KEYS) {
        throw new Error('free-tier limiter capacity reached while persistent metering is unavailable');
      }
      // Commit both buckets together: pruning while creating the IP bucket
      // must not remove the address bucket before its first request is added.
      for (const [key, timestamps] of buckets) {
        timestamps.push(nowMs);
        this._inMemoryUsage.set(key, timestamps);
      }
    }
    return decision;
  }

  private _pruneExpiredBuckets(windowStart: number): void {
    for (const [key, timestamps] of this._inMemoryUsage) {
      if ((timestamps.at(-1) ?? 0) < windowStart) {
        this._inMemoryUsage.delete(key);
      }
    }
  }
}

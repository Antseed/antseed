import { freeTierStakeTierForPower, type FreeTierStakeTier } from './free-tier-program.js';
import { debugWarn } from '../utils/debug.js';

/** A seller-pool position and its staking power at the current epoch. */
export interface FreeTierStakePosition {
  id: number;
  /** ANTS wei × epochs of lock remaining. */
  power: bigint;
}

/** On-chain reads the staked free tier needs. */
export interface FreeTierStakeReader {
  /** The seller's agent id in the seller pools, or 0 when it has none. */
  sellerAgentId(): Promise<number>;
  currentEpoch(): Promise<number>;
  /** `staker`'s positions with power in `agentId`'s pool at `epoch`. */
  stakerPositions(staker: string, agentId: number, epoch: number): Promise<FreeTierStakePosition[]>;
}

/** A buyer whose own stake plus its delegated stake reaches a tier on this seller. */
export interface FreeTierStakeStanding {
  /** Addresses whose stake counts: the buyer and every staker that delegated to it. */
  stakers: string[];
  /** Combined power of every counted position. */
  power: bigint;
  tier: FreeTierStakeTier;
  /**
   * Positions the allowance is counted on. Usage follows the positions, not
   * the staker, so transferring a position carries its used allowance along.
   */
  positionIds: number[];
}

export interface FreeTierStakeResolverOptions {
  /** How long a standing and a staker's positions are reused. Default: 10 minutes. */
  cacheTtlMs?: number;
  /** How long a failed lookup is remembered before retrying. Default: 30 seconds. */
  failureTtlMs?: number;
  /** Lookups slower than this fall back to base limits for this request. Default: 3 seconds. */
  lookupTimeoutMs?: number;
  maxEntries?: number;
  now?: () => number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/** Most positions one request is counted on; the strongest positions come first. */
export const MAX_FREE_TIER_COUNTED_POSITIONS = 64;

/**
 * Resolves which staked tier, if any, a buyer gets on this seller.
 *
 * The buyer's own stake counts, plus the stake of every staker that signed a
 * delegation to it (verified by the caller). Their positions in this seller's
 * pool are pooled: power is summed and usage is counted on every position.
 * Any read failure resolves to no tier, so the buyer keeps the base limits:
 * an RPC outage can only make the free tier stricter, never looser.
 */
export class FreeTierStakeResolver {
  private readonly _cacheTtlMs: number;
  private readonly _failureTtlMs: number;
  private readonly _lookupTimeoutMs: number;
  private readonly _maxEntries: number;
  private readonly _now: () => number;
  private readonly _standings = new Map<string, CacheEntry<FreeTierStakeStanding | null>>();
  private readonly _positions = new Map<string, CacheEntry<FreeTierStakePosition[]>>();
  private readonly _inFlight = new Map<string, Promise<FreeTierStakeStanding | null>>();
  private _agentId: CacheEntry<number> | null = null;
  private _epoch: CacheEntry<number> | null = null;

  constructor(
    private readonly _reader: FreeTierStakeReader,
    readonly stakeTiers: readonly FreeTierStakeTier[],
    options: FreeTierStakeResolverOptions = {},
  ) {
    this._cacheTtlMs = options.cacheTtlMs ?? 10 * 60_000;
    this._failureTtlMs = options.failureTtlMs ?? 30_000;
    this._lookupTimeoutMs = options.lookupTimeoutMs ?? 3_000;
    this._maxEntries = options.maxEntries ?? 20_000;
    this._now = options.now ?? Date.now;
  }

  /**
   * The staked standing of `buyerAddress` together with `delegatedStakers`
   * (already verified), or null when it gets the base limits.
   */
  async resolve(buyerAddress: string, delegatedStakers: readonly string[] = []): Promise<FreeTierStakeStanding | null> {
    if (this.stakeTiers.length === 0) return null;
    const stakers = [...new Set([buyerAddress, ...delegatedStakers].map((address) => address.toLowerCase()))];
    const key = stakers.join(',');
    const cached = this._standings.get(key);
    if (cached && cached.expiresAt > this._now()) return cached.value;

    let pending = this._inFlight.get(key);
    if (!pending) {
      pending = this._lookup(stakers)
        .then((standing) => {
          this._remember(this._standings, key, standing, this._cacheTtlMs);
          return standing;
        })
        .catch((err) => {
          debugWarn(`[FreeTierStake] Stake lookup failed for ${stakers[0]}: ${err instanceof Error ? err.message : err}`);
          this._remember(this._standings, key, null, this._failureTtlMs);
          return null;
        })
        .finally(() => this._inFlight.delete(key));
      this._inFlight.set(key, pending);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this._lookupTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  private async _lookup(stakers: string[]): Promise<FreeTierStakeStanding | null> {
    const agentId = await this._sellerAgentId();
    if (agentId <= 0) return null;
    const epoch = await this._currentEpoch();
    const holdings = await Promise.all(stakers.map((staker) => this._stakerPositions(staker, agentId, epoch)));

    const positions = new Map<number, FreeTierStakePosition>();
    for (const position of holdings.flat()) positions.set(position.id, position);
    const power = [...positions.values()].reduce((sum, position) => sum + position.power, 0n);
    const tier = freeTierStakeTierForPower(this.stakeTiers, power);
    if (!tier) return null;
    const positionIds = [...positions.values()]
      .sort((a, b) => (a.power === b.power ? a.id - b.id : a.power > b.power ? -1 : 1))
      .slice(0, MAX_FREE_TIER_COUNTED_POSITIONS)
      .map((position) => position.id);
    return { stakers, power, tier, positionIds };
  }

  private async _stakerPositions(staker: string, agentId: number, epoch: number): Promise<FreeTierStakePosition[]> {
    const cached = this._positions.get(staker);
    if (cached && cached.expiresAt > this._now()) return cached.value;
    const positions = await this._reader.stakerPositions(staker, agentId, epoch);
    this._remember(this._positions, staker, positions, this._cacheTtlMs);
    return positions;
  }

  private async _sellerAgentId(): Promise<number> {
    if (this._agentId && this._agentId.expiresAt > this._now()) return this._agentId.value;
    const agentId = await this._reader.sellerAgentId();
    this._agentId = { value: agentId, expiresAt: this._now() + this._cacheTtlMs };
    return agentId;
  }

  private async _currentEpoch(): Promise<number> {
    if (this._epoch && this._epoch.expiresAt > this._now()) return this._epoch.value;
    const epoch = await this._reader.currentEpoch();
    this._epoch = { value: epoch, expiresAt: this._now() + this._cacheTtlMs };
    return epoch;
  }

  private _remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttlMs: number): void {
    cache.delete(key);
    if (cache.size >= this._maxEntries) {
      const now = this._now();
      for (const [entryKey, entry] of cache) {
        if (entry.expiresAt <= now) cache.delete(entryKey);
      }
      while (cache.size >= this._maxEntries) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined) break;
        cache.delete(oldest);
      }
    }
    cache.set(key, { value, expiresAt: this._now() + ttlMs });
  }
}

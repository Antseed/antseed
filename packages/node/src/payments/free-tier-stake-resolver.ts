import { freeTierStakeTierForPower, type FreeTierStakeTier } from './free-tier-program.js';
import { debugWarn } from '../utils/debug.js';

/** On-chain reads the staked free tier needs. */
export interface FreeTierStakeReader {
  /** The seller's agent id in the seller pools, or 0 when it has none. */
  sellerAgentId(): Promise<number>;
  currentEpoch(): Promise<number>;
  /** Power (ANTS wei × epochs remaining) `staker` holds in `agentId`'s pool at `epoch`. */
  stakerPower(staker: string, agentId: number, epoch: number): Promise<bigint>;
  /** The buyer's authorized operator in AntseedDeposits, or null when unset. */
  operatorOf(buyer: string): Promise<string | null>;
}

/** A buyer whose stake (its own or its operator's) reaches a tier on this seller. */
export interface FreeTierStakeStanding {
  /**
   * Address holding the stake. Every buyer address resolving to the same
   * owner shares one allowance counter, so adding wallets splits it.
   */
  owner: string;
  power: bigint;
  tier: FreeTierStakeTier;
}

export interface FreeTierStakeResolverOptions {
  /** How long a buyer's standing and an owner's power are reused. Default: 10 minutes. */
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

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/**
 * Resolves which staked tier, if any, a buyer gets on this seller.
 *
 * The buyer's own stake and its operator's stake are both considered; the
 * larger one wins and becomes the allowance owner. Any read failure resolves
 * to no tier, so the buyer keeps the base limits: an RPC outage can only make
 * the free tier stricter, never looser.
 */
export class FreeTierStakeResolver {
  private readonly _cacheTtlMs: number;
  private readonly _failureTtlMs: number;
  private readonly _lookupTimeoutMs: number;
  private readonly _maxEntries: number;
  private readonly _now: () => number;
  private readonly _standings = new Map<string, CacheEntry<FreeTierStakeStanding | null>>();
  private readonly _powers = new Map<string, CacheEntry<bigint>>();
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

  /** The buyer's staked standing, or null when it gets the base limits. */
  async resolve(buyerAddress: string): Promise<FreeTierStakeStanding | null> {
    if (this.stakeTiers.length === 0) return null;
    const buyer = buyerAddress.toLowerCase();
    const cached = this._standings.get(buyer);
    if (cached && cached.expiresAt > this._now()) return cached.value;

    let pending = this._inFlight.get(buyer);
    if (!pending) {
      pending = this._lookup(buyer)
        .then((standing) => {
          this._remember(this._standings, buyer, standing, this._cacheTtlMs);
          return standing;
        })
        .catch((err) => {
          debugWarn(`[FreeTierStake] Stake lookup failed for ${buyer}: ${err instanceof Error ? err.message : err}`);
          this._remember(this._standings, buyer, null, this._failureTtlMs);
          return null;
        })
        .finally(() => this._inFlight.delete(buyer));
      this._inFlight.set(buyer, pending);
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

  private async _lookup(buyer: string): Promise<FreeTierStakeStanding | null> {
    const agentId = await this._sellerAgentId();
    if (agentId <= 0) return null;
    const [epoch, operator] = await Promise.all([this._currentEpoch(), this._reader.operatorOf(buyer)]);
    const candidates = [buyer];
    const normalizedOperator = operator?.toLowerCase();
    if (normalizedOperator && normalizedOperator !== ZERO_ADDRESS && normalizedOperator !== buyer) {
      candidates.push(normalizedOperator);
    }
    const powers = await Promise.all(candidates.map((owner) => this._ownerPower(owner, agentId, epoch)));

    let bestIndex = 0;
    for (let index = 1; index < candidates.length; index += 1) {
      if (powers[index]! > powers[bestIndex]!) bestIndex = index;
    }
    const owner = candidates[bestIndex]!;
    const power = powers[bestIndex]!;
    const tier = freeTierStakeTierForPower(this.stakeTiers, power);
    return tier ? { owner, power, tier } : null;
  }

  private async _ownerPower(owner: string, agentId: number, epoch: number): Promise<bigint> {
    const cached = this._powers.get(owner);
    if (cached && cached.expiresAt > this._now()) return cached.value;
    const power = await this._reader.stakerPower(owner, agentId, epoch);
    this._remember(this._powers, owner, power, this._cacheTtlMs);
    return power;
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

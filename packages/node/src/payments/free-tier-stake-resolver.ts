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

/**
 * A buyer whose own stake plus its delegated stake has power in this seller's
 * pool. Which tier that power earns depends on the program a request is under.
 */
export interface FreeTierStakeStanding {
  /** Addresses whose stake counts: the buyer and every staker that delegated to it. */
  stakers: string[];
  /** Combined power of every counted position. */
  power: bigint;
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
  /** When the read behind this entry started, so a slower, older read cannot replace a newer one. */
  seq: number;
}

/** Most positions one request is counted on; the strongest positions come first. */
export const MAX_FREE_TIER_COUNTED_POSITIONS = 64;

/**
 * Resolves a buyer's staked standing on this seller.
 *
 * The buyer's own stake counts, plus the stake of every staker that signed a
 * delegation to it (verified by the caller). Their positions in this seller's
 * pool are pooled: power is summed and usage is counted on every position.
 * Any read failure resolves to no standing, so the buyer keeps the base limits:
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
  private _seq = 0;

  constructor(
    private readonly _reader: FreeTierStakeReader,
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
   * (already verified), or null when none of them has power in the pool.
   */
  async resolve(buyerAddress: string, delegatedStakers: readonly string[] = []): Promise<FreeTierStakeStanding | null> {
    const stakers = [...new Set([buyerAddress, ...delegatedStakers].map((address) => address.toLowerCase()))];
    const key = stakers.join(',');
    const cached = this._standings.get(key);
    if (cached && cached.expiresAt > this._now()) return cached.value;

    let pending = this._inFlight.get(key);
    if (!pending) {
      const seq = ++this._seq;
      const lookup: Promise<FreeTierStakeStanding | null> = this._lookup(stakers, seq)
        .then(({ value: standing, expiresAt }) => {
          // A standing never outlives the stake snapshots it was derived from.
          return this._remember(this._standings, key, standing, expiresAt, seq).value;
        })
        .catch((err) => {
          debugWarn(`[FreeTierStake] Stake lookup failed for ${stakers[0]}: ${err instanceof Error ? err.message : err}`);
          // A lookup that timed out and was replaced must not overwrite its replacement's result.
          this._remember(this._standings, key, null, this._now() + this._failureTtlMs, seq);
          return null;
        })
        .finally(() => {
          if (this._inFlight.get(key) === lookup) this._inFlight.delete(key);
        });
      pending = lookup;
      this._inFlight.set(key, pending);
    }

    const current = pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        // A stalled lookup must not block the next request from trying again.
        if (this._inFlight.get(key) === current) this._inFlight.delete(key);
        resolve(null);
      }, this._lookupTimeoutMs);
    });
    try {
      return await Promise.race([pending, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  /** The standing of `stakers`, and when the earliest snapshot it was built from expires. */
  private async _lookup(stakers: string[], seq: number): Promise<Omit<CacheEntry<FreeTierStakeStanding | null>, 'seq'>> {
    const agentId = await this._sellerAgentId(seq);
    if (agentId.value <= 0) return { value: null, expiresAt: agentId.expiresAt };
    const epoch = await this._currentEpoch(seq);
    const holdings = await Promise.all(stakers.map((staker) => this._stakerPositions(staker, agentId.value, epoch.value, seq)));
    const expiresAt = Math.min(agentId.expiresAt, epoch.expiresAt, ...holdings.map((entry) => entry.expiresAt));

    const unique = new Map<number, FreeTierStakePosition>();
    for (const position of holdings.flatMap((entry) => entry.value)) unique.set(position.id, position);
    // Only the positions that are charged for usage may count toward a tier,
    // so stake left out by the cap cannot back a second, untouched allowance.
    const counted = [...unique.values()]
      .sort((a, b) => (a.power === b.power ? a.id - b.id : a.power > b.power ? -1 : 1))
      .slice(0, MAX_FREE_TIER_COUNTED_POSITIONS);
    const power = counted.reduce((sum, position) => sum + position.power, 0n);
    if (power <= 0n) return { value: null, expiresAt };
    return { value: { stakers, power, positionIds: counted.map((position) => position.id) }, expiresAt };
  }

  private async _stakerPositions(staker: string, agentId: number, epoch: number, seq: number): Promise<CacheEntry<FreeTierStakePosition[]>> {
    const cached = this._positions.get(staker);
    if (cached && cached.expiresAt > this._now()) return cached;
    const positions = await this._reader.stakerPositions(staker, agentId, epoch);
    return this._remember(this._positions, staker, positions, this._now() + this._cacheTtlMs, seq);
  }

  private async _sellerAgentId(seq: number): Promise<CacheEntry<number>> {
    if (this._agentId && this._agentId.expiresAt > this._now()) return this._agentId;
    const agentId = await this._reader.sellerAgentId();
    this._agentId = newer(this._agentId, { value: agentId, expiresAt: this._now() + this._cacheTtlMs, seq });
    return this._agentId;
  }

  private async _currentEpoch(seq: number): Promise<CacheEntry<number>> {
    if (this._epoch && this._epoch.expiresAt > this._now()) return this._epoch;
    const epoch = await this._reader.currentEpoch();
    this._epoch = newer(this._epoch, { value: epoch, expiresAt: this._now() + this._cacheTtlMs, seq });
    return this._epoch;
  }

  /** Stores `value` unless a read that started later already stored a result, which is kept and returned instead. */
  private _remember<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, expiresAt: number, seq: number): CacheEntry<T> {
    const existing = cache.get(key);
    if (existing && existing.seq > seq) return existing;
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
    const entry = { value, expiresAt, seq };
    cache.set(key, entry);
    return entry;
  }
}

function newer<T>(existing: CacheEntry<T> | null, candidate: CacheEntry<T>): CacheEntry<T> {
  return existing && existing.seq > candidate.seq ? existing : candidate;
}

/**
 * Per-buyer usage limits for a seller: how many tokens one buyer may use from
 * one provider in a rolling window, with tighter limits for buyers new to this
 * seller. A provider is usually one upstream account, so each provider is
 * counted on its own.
 *
 * Tokens are uncached input plus output: cached input costs an upstream
 * subscription little, so a buyer that reuses its prompt cache is not limited
 * for it.
 */

export interface SellerNewBuyerLimitsConfig {
  /** A buyer counts as new until this many hours after its first channel with this seller. Default: 72. */
  forHours?: number;
  /** Most tokens one new buyer may use from one provider per window. */
  maxTokensPerBuyer?: number;
  /** Most tokens all new buyers together may use from one provider per window. */
  maxTokensTotal?: number;
}

export interface SellerBuyerLimitsConfig {
  /** Rolling window usage is counted over, in minutes. Default: 60. */
  windowMinutes?: number;
  /** Most tokens one buyer may use from one provider per window. */
  maxTokensPerBuyer?: number;
  /** Tighter limits for buyers new to this seller. */
  newBuyers?: SellerNewBuyerLimitsConfig;
}

const DEFAULT_WINDOW_MINUTES = 60;
const DEFAULT_NEW_BUYER_HOURS = 72;
const BUCKET_MS = 60_000;
/** Records between sweeps of buyers whose usage has left the window. */
const SWEEP_EVERY_RECORDS = 1_000;

/** Retry-after while a buyer is held back only by its own requests still in flight. */
const IN_FLIGHT_RETRY_MS = 5_000;

/** Token counts per minute, keyed by minute index. */
type Buckets = Map<number, number>;

interface ProviderUsage {
  buyers: Map<string, Buckets>;
  newBuyers: Buckets;
  /** Tokens reserved by requests still in flight, per buyer and for all new buyers. */
  pending: Map<string, number>;
  newPending: number;
}

/** An admitted request's reservation; finish it exactly once with the tokens it really used. */
export interface BuyerUsageReservation {
  finish(tokens: number): void;
}

export type BuyerUsageAdmission =
  | { admitted: true; reservation: BuyerUsageReservation }
  | { admitted: false; retryAfterSeconds: number };

export class SellerBuyerLimiter {
  private readonly _windowMs: number;
  private readonly _newBuyerMs: number;
  private readonly _usage = new Map<string, ProviderUsage>();
  /** First channel time per buyer, once known; it never changes after that. */
  private readonly _firstSeen = new Map<string, number>();
  private _recordsSinceSweep = 0;

  constructor(
    private readonly _config: SellerBuyerLimitsConfig,
    /** When the buyer's first channel with this seller was created (ms), or null when it has none. */
    private readonly _firstChannelAt: (buyerPeerId: string) => number | null,
    private readonly _now: () => number = Date.now,
  ) {
    this._windowMs = (_config.windowMinutes ?? DEFAULT_WINDOW_MINUTES) * 60_000;
    this._newBuyerMs = (_config.newBuyers?.forHours ?? DEFAULT_NEW_BUYER_HOURS) * 3_600_000;
  }

  /**
   * Seconds until the buyer may use the provider again, or null while it is
   * within its limits. Requests still in flight count with their estimates.
   */
  retryAfterSeconds(buyerPeerId: string, provider: string): number | null {
    return this._retryAfter(buyerPeerId, provider, this._isNewBuyer(buyerPeerId, this._now()), 0);
  }

  /**
   * Admits a request about to go upstream and reserves its estimated tokens
   * until it finishes, so concurrent requests can't all pass on the same usage.
   */
  admit(buyerPeerId: string, provider: string, estimatedTokens: number): BuyerUsageAdmission {
    const isNew = this._isNewBuyer(buyerPeerId, this._now());
    const reserved = Math.max(0, estimatedTokens);
    const retryAfterSeconds = this._retryAfter(buyerPeerId, provider, isNew, reserved);
    if (retryAfterSeconds !== null) return { admitted: false, retryAfterSeconds };
    const usage = this._providerUsage(provider);
    usage.pending.set(buyerPeerId, (usage.pending.get(buyerPeerId) ?? 0) + reserved);
    if (isNew) usage.newPending += reserved;
    let finished = false;
    return {
      admitted: true,
      reservation: {
        finish: (tokens) => {
          if (finished) return;
          finished = true;
          const left = (usage.pending.get(buyerPeerId) ?? 0) - reserved;
          if (left > 0) usage.pending.set(buyerPeerId, left);
          else usage.pending.delete(buyerPeerId);
          if (isNew) usage.newPending = Math.max(0, usage.newPending - reserved);
          this._record(buyerPeerId, usage, tokens, isNew);
        },
      },
    };
  }

  describe(): string {
    const parts = [`window=${this._windowMs / 60_000}m`];
    if (this._config.maxTokensPerBuyer !== undefined) parts.push(`perBuyer=${this._config.maxTokensPerBuyer}`);
    const fresh = this._config.newBuyers;
    if (fresh) {
      parts.push(`newFor=${this._newBuyerMs / 3_600_000}h`);
      if (fresh.maxTokensPerBuyer !== undefined) parts.push(`newPerBuyer=${fresh.maxTokensPerBuyer}`);
      if (fresh.maxTokensTotal !== undefined) parts.push(`newTotal=${fresh.maxTokensTotal}`);
    }
    return parts.join(' ');
  }

  private _retryAfter(buyerPeerId: string, provider: string, isNew: boolean, extra: number): number | null {
    const now = this._now();
    const usage = this._usage.get(provider);
    if (!usage) return null;
    const waits: number[] = [];
    const perBuyer = isNew ? this._config.newBuyers?.maxTokensPerBuyer ?? this._config.maxTokensPerBuyer : this._config.maxTokensPerBuyer;
    if (perBuyer !== undefined) {
      waits.push(this._msUntilFits(usage.buyers.get(buyerPeerId), perBuyer, usage.pending.get(buyerPeerId) ?? 0, extra, now));
    }
    const total = this._config.newBuyers?.maxTokensTotal;
    if (isNew && total !== undefined) waits.push(this._msUntilFits(usage.newBuyers, total, usage.newPending, extra, now));
    const wait = Math.max(0, ...waits);
    return wait > 0 ? Math.ceil(wait / 1000) : null;
  }

  /** Counts a finished request's uncached input and output tokens. */
  private _record(buyerPeerId: string, usage: ProviderUsage, tokens: number, isNew: boolean): void {
    if (!(tokens > 0)) return;
    const now = this._now();
    let buckets = usage.buyers.get(buyerPeerId);
    if (!buckets) {
      buckets = new Map();
      usage.buyers.set(buyerPeerId, buckets);
    }
    addTokens(buckets, now, tokens);
    if (isNew) addTokens(usage.newBuyers, now, tokens);
    if (++this._recordsSinceSweep >= SWEEP_EVERY_RECORDS) this._sweep(now);
  }

  private _providerUsage(provider: string): ProviderUsage {
    let usage = this._usage.get(provider);
    if (!usage) {
      usage = { buyers: new Map(), newBuyers: new Map(), pending: new Map(), newPending: 0 };
      this._usage.set(provider, usage);
    }
    return usage;
  }

  private _isNewBuyer(buyer: string, now: number): boolean {
    if (!this._config.newBuyers) return false;
    let first = this._firstSeen.get(buyer);
    if (first === undefined) {
      const found = this._firstChannelAt(buyer);
      if (found === null) return true;
      first = found;
      this._firstSeen.set(buyer, first);
    }
    return now - first < this._newBuyerMs;
  }

  /** A minute's tokens stay counted until a full window after the minute ends, never less. */
  private _expiresAt(minute: number): number {
    return (minute + 1) * BUCKET_MS + this._windowMs;
  }

  /**
   * How long until a request reserving `extra` tokens fits under the limit, on
   * top of the window's usage and the `pending` tokens of requests in flight
   * (0 when it fits now). A limit already reached holds every request; a
   * request alone, with no usage or requests before it, is never held back
   * for its own size.
   */
  private _msUntilFits(buckets: Buckets | undefined, limit: number, pending: number, extra: number, now: number): number {
    let used = 0;
    if (buckets) {
      for (const [minute, tokens] of buckets) {
        if (this._expiresAt(minute) <= now) buckets.delete(minute);
        else used += tokens;
      }
    }
    const fits = (inWindow: number): boolean => inWindow + pending < limit && (inWindow + pending === 0 || inWindow + pending + extra <= limit);
    if (fits(used)) return 0;
    // Even an empty window wouldn't make room: wait for requests in flight to finish.
    if (!fits(0)) return IN_FLIGHT_RETRY_MS;
    for (const minute of [...(buckets?.keys() ?? [])].sort((a, b) => a - b)) {
      used -= buckets!.get(minute)!;
      if (fits(used)) return this._expiresAt(minute) - now;
    }
    return IN_FLIGHT_RETRY_MS;
  }

  private _sweep(now: number): void {
    this._recordsSinceSweep = 0;
    for (const usage of this._usage.values()) {
      for (const [buyer, buckets] of usage.buyers) {
        for (const minute of buckets.keys()) if (this._expiresAt(minute) <= now) buckets.delete(minute);
        if (buckets.size === 0) usage.buyers.delete(buyer);
      }
      for (const minute of usage.newBuyers.keys()) if (this._expiresAt(minute) <= now) usage.newBuyers.delete(minute);
    }
  }
}

function addTokens(buckets: Buckets, now: number, tokens: number): void {
  const minute = Math.floor(now / BUCKET_MS);
  buckets.set(minute, (buckets.get(minute) ?? 0) + tokens);
}

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

/** Token counts per minute, keyed by minute index. */
type Buckets = Map<number, number>;

interface ProviderUsage {
  buyers: Map<string, Buckets>;
  newBuyers: Buckets;
}

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

  /** Seconds until the buyer may use the provider again, or null while it is within its limits. */
  retryAfterSeconds(buyerPeerId: string, provider: string): number | null {
    const now = this._now();
    const usage = this._usage.get(provider);
    const isNew = this._isNewBuyer(buyerPeerId, now);
    const waits: number[] = [];
    const perBuyer = isNew ? this._config.newBuyers?.maxTokensPerBuyer ?? this._config.maxTokensPerBuyer : this._config.maxTokensPerBuyer;
    const buyerBuckets = usage?.buyers.get(buyerPeerId);
    if (perBuyer !== undefined && buyerBuckets) waits.push(this._msUntilUnder(buyerBuckets, perBuyer, now));
    const total = this._config.newBuyers?.maxTokensTotal;
    if (isNew && total !== undefined && usage) waits.push(this._msUntilUnder(usage.newBuyers, total, now));
    const wait = Math.max(0, ...waits);
    return wait > 0 ? Math.ceil(wait / 1000) : null;
  }

  /** Counts a served request's uncached input and output tokens. */
  record(buyerPeerId: string, provider: string, tokens: number): void {
    if (!(tokens > 0)) return;
    const now = this._now();
    let usage = this._usage.get(provider);
    if (!usage) {
      usage = { buyers: new Map(), newBuyers: new Map() };
      this._usage.set(provider, usage);
    }
    let buckets = usage.buyers.get(buyerPeerId);
    if (!buckets) {
      buckets = new Map();
      usage.buyers.set(buyerPeerId, buckets);
    }
    addTokens(buckets, now, tokens);
    if (this._isNewBuyer(buyerPeerId, now)) addTokens(usage.newBuyers, now, tokens);
    if (++this._recordsSinceSweep >= SWEEP_EVERY_RECORDS) this._sweep(now);
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

  /** How long until the tokens in the window drop below the limit (0 when they already are). */
  private _msUntilUnder(buckets: Buckets, limit: number, now: number): number {
    const oldest = Math.floor((now - this._windowMs) / BUCKET_MS);
    let used = 0;
    for (const [minute, tokens] of buckets) {
      if (minute <= oldest) buckets.delete(minute);
      else used += tokens;
    }
    if (used < limit) return 0;
    for (const minute of [...buckets.keys()].sort((a, b) => a - b)) {
      used -= buckets.get(minute)!;
      if (used < limit) return minute * BUCKET_MS + this._windowMs - now;
    }
    return 0;
  }

  private _sweep(now: number): void {
    this._recordsSinceSweep = 0;
    const oldest = Math.floor((now - this._windowMs) / BUCKET_MS);
    for (const usage of this._usage.values()) {
      for (const [buyer, buckets] of usage.buyers) {
        for (const minute of buckets.keys()) if (minute <= oldest) buckets.delete(minute);
        if (buckets.size === 0) usage.buyers.delete(buyer);
      }
      for (const minute of usage.newBuyers.keys()) if (minute <= oldest) usage.newBuyers.delete(minute);
    }
  }
}

function addTokens(buckets: Buckets, now: number, tokens: number): void {
  const minute = Math.floor(now / BUCKET_MS);
  buckets.set(minute, (buckets.get(minute) ?? 0) + tokens);
}

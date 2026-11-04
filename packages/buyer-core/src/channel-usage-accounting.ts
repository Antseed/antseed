import {
  withServiceMetadata,
  ZERO_METADATA,
  type ServiceMetadataDelta,
  type SpendingAuthMetadata,
} from '@antseed/protocol/signatures';

const DEFAULT_REQUEST_TRACKER_LIMIT = 512;

function trimOldestMapEntry<K, V>(map: Map<K, V>, limit: number): void {
  if (map.size < limit) return;
  const oldest = map.keys().next().value;
  if (oldest !== undefined) map.delete(oldest);
}

export class RequestServiceTracker {
  private readonly _services = new Map<string, string>();

  constructor(private readonly _limit = DEFAULT_REQUEST_TRACKER_LIMIT) {}

  track(requestId: string, service: string): void {
    trimOldestMapEntry(this._services, this._limit);
    this._services.set(requestId, service);
  }

  get(requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    return this._services.get(requestId);
  }

  take(requestId: string | undefined): string | undefined {
    if (!requestId) return undefined;
    const service = this._services.get(requestId);
    this._services.delete(requestId);
    return service;
  }
}

export class CountedRequestTracker {
  // requestId -> part of the request's accepted cost not yet signed (a NeedAuth
  // capped at the reserve ceiling counts the request but signs only part of it).
  private readonly _unpaid = new Map<string, bigint>();

  /**
   * `keep` names requests that must not be trimmed (a worker request whose
   * delivery record still exists: its unpaid remainder is still owed to it).
   */
  constructor(
    private readonly _limit = DEFAULT_REQUEST_TRACKER_LIMIT,
    private readonly _keep: (requestId: string) => boolean = () => false,
  ) {}

  private _trim(): void {
    if (this._unpaid.size < this._limit) return;
    for (const requestId of this._unpaid.keys()) {
      if (this._keep(requestId)) continue;
      this._unpaid.delete(requestId);
      return;
    }
  }

  has(requestId: string | undefined): boolean {
    return requestId != null && this._unpaid.has(requestId);
  }

  mark(requestId: string | undefined, unpaidAmount = 0n): void {
    if (!requestId) return;
    if (!this._unpaid.has(requestId)) this._trim();
    this._unpaid.set(requestId, unpaidAmount > 0n ? unpaidAmount : 0n);
  }

  unpaid(requestId: string | undefined): bigint {
    if (!requestId) return 0n;
    return this._unpaid.get(requestId) ?? 0n;
  }

  /** Record that `amount` of a counted request's unpaid cost has now been signed. */
  pay(requestId: string | undefined, amount: bigint): void {
    if (!requestId || amount <= 0n) return;
    const remaining = this._unpaid.get(requestId);
    if (remaining == null) return;
    this._unpaid.set(requestId, remaining > amount ? remaining - amount : 0n);
  }
}

export function normalizeRequestUsageDelta(
  delta: ServiceMetadataDelta,
  options: { deliveredResponse: boolean; alreadyCounted: boolean },
): ServiceMetadataDelta {
  if (options.deliveredResponse && !options.alreadyCounted) return delta;

  // NeedAuth and post-response signing can both report the same request cost.
  // Once a delivered response has been attributed, the racing path must not
  // count its amount or usage again. A budget/headroom NeedAuth does not
  // describe a delivered response at all, so it contributes nothing.
  return {
    amount: 0n,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: 0n,
    requests: 0n,
    outputImages: 0n,
    videoGenerations: 0n,
    videoSeconds: 0n,
    inputCharacters: 0n,
  };
}

export function advanceUsageMetadata(
  previous: SpendingAuthMetadata | undefined,
  service: string | undefined,
  delta: ServiceMetadataDelta,
): SpendingAuthMetadata {
  const prev = previous ?? ZERO_METADATA;
  const totals: SpendingAuthMetadata = {
    cumulativeInputTokens: prev.cumulativeInputTokens + delta.inputTokens,
    cumulativeOutputTokens: prev.cumulativeOutputTokens + delta.outputTokens,
    cumulativeRequestCount: prev.cumulativeRequestCount + delta.requests,
    cumulativeOutputImages: (prev.cumulativeOutputImages ?? 0n) + delta.outputImages,
    cumulativeVideoGenerations: (prev.cumulativeVideoGenerations ?? 0n) + (delta.videoGenerations ?? 0n),
    cumulativeVideoSeconds: (prev.cumulativeVideoSeconds ?? 0n) + (delta.videoSeconds ?? 0n),
    cumulativeInputCharacters: (prev.cumulativeInputCharacters ?? 0n) + (delta.inputCharacters ?? 0n),
    services: prev.services ?? [],
    ...(prev.workers ? { workers: prev.workers } : {}),
  };
  return withServiceMetadata(totals, service, delta);
}

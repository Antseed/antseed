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

  constructor(private readonly _limit = DEFAULT_REQUEST_TRACKER_LIMIT) {}

  has(requestId: string | undefined): boolean {
    return requestId != null && this._unpaid.has(requestId);
  }

  mark(requestId: string | undefined, unpaidAmount = 0n): void {
    if (!requestId) return;
    trimOldestMapEntry(this._unpaid, this._limit);
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
    services: prev.services ?? [],
  };
  return withServiceMetadata(totals, service, delta);
}

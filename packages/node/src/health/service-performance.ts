import {
  MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS,
  MAX_SERVICE_PERFORMANCE_REQUESTS,
  MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND,
  SERVICE_PERFORMANCE_WINDOW_MS,
  type ServicePerformance,
} from '../discovery/peer-metadata.js';

/** Requests and successes are counted per minute, so the window's counts are exact at any volume. */
const BUCKET_MS = 60_000;
/** Timings kept per provider and service: the percentiles describe the newest this many timed answers. */
const MAX_TIMED_SAMPLES = 500;
/** Answers shorter than this say little about streaming speed. */
const MIN_THROUGHPUT_TOKENS = 20;

/** One buyer request a seller relayed upstream. */
export interface ServicePerformanceSample {
  /** False when the upstream failed it (a server-side error, rate limit, exception or an error inside the stream), not for a client error. */
  ok: boolean;
  /** Time from receiving the request to the first generated token. Absent for answers that were not streamed. */
  firstTokenMs?: number;
  /** Time from the first generated token to the end of the answer. */
  streamMs?: number;
  outputTokens?: number;
}

interface Bucket {
  minute: number;
  requests: number;
  ok: number;
}

interface Timing {
  at: number;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
}

interface ServiceRecord {
  buckets: Bucket[];
  timings: Timing[];
}

/**
 * How each service served buyers over the last hour, for the seller to
 * announce: request count and success rate, and the first-token time and
 * output speed of streamed answers. Keyed by provider name, so upstreams
 * sharing a name (which must offer a service on the same terms) report one
 * figure.
 */
export class ServicePerformanceTracker {
  private readonly _records = new Map<string, ServiceRecord>();

  constructor(private readonly _windowMs = SERVICE_PERFORMANCE_WINDOW_MS) {}

  record(provider: string, service: string, sample: ServicePerformanceSample, now = Date.now()): void {
    const key = `${provider}\u0000${service}`;
    const record = this._records.get(key) ?? { buckets: [], timings: [] };
    this._records.set(key, record);
    const minute = Math.floor(now / BUCKET_MS);
    let bucket = record.buckets[record.buckets.length - 1];
    if (!bucket || bucket.minute !== minute) {
      bucket = { minute, requests: 0, ok: 0 };
      record.buckets.push(bucket);
    }
    bucket.requests += 1;
    if (sample.ok) bucket.ok += 1;

    if (!sample.ok) return;
    const outputTokens = sample.outputTokens ?? 0;
    const firstTokenMs = isDuration(sample.firstTokenMs) ? sample.firstTokenMs : null;
    const tokensPerSecond = outputTokens >= MIN_THROUGHPUT_TOKENS && isDuration(sample.streamMs) && sample.streamMs > 0
      ? outputTokens / (sample.streamMs / 1000)
      : null;
    if (firstTokenMs === null && tokensPerSecond === null) return;
    record.timings.push({ at: now, firstTokenMs, tokensPerSecond });
    if (record.timings.length > MAX_TIMED_SAMPLES) record.timings.splice(0, record.timings.length - MAX_TIMED_SAMPLES);
  }

  /** The announced figures for each of `services` with requests in the window. */
  snapshot(provider: string, services: readonly string[], now = Date.now()): Record<string, ServicePerformance> | undefined {
    const result = Object.create(null) as Record<string, ServicePerformance>;
    for (const service of services) {
      const performance = this.performance(provider, service, now);
      if (performance) result[service] = performance;
    }
    return Object.keys(result).length > 0 ? result : undefined;
  }

  performance(provider: string, service: string, now = Date.now()): ServicePerformance | undefined {
    const key = `${provider}\u0000${service}`;
    const record = this._records.get(key);
    if (!record) return undefined;
    const since = now - this._windowMs;
    // A minute that started before the window still counts while any of it is inside.
    record.buckets = record.buckets.filter((bucket) => (bucket.minute + 1) * BUCKET_MS > since);
    record.timings = record.timings.filter((timing) => timing.at > since);
    const requests = record.buckets.reduce((sum, bucket) => sum + bucket.requests, 0);
    if (requests === 0) {
      this._records.delete(key);
      return undefined;
    }
    const ok = record.buckets.reduce((sum, bucket) => sum + bucket.ok, 0);
    const performance: ServicePerformance = {
      requests: Math.min(requests, MAX_SERVICE_PERFORMANCE_REQUESTS),
      successRate: Math.round((ok / requests) * 10_000) / 10_000,
    };
    const firstTokens = record.timings.flatMap((timing) => timing.firstTokenMs === null ? [] : [timing.firstTokenMs]);
    if (firstTokens.length > 0) {
      performance.firstTokenMsP50 = Math.min(Math.round(percentile(firstTokens, 0.5)), MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
      performance.firstTokenMsP90 = Math.min(Math.round(percentile(firstTokens, 0.9)), MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
    }
    const speeds = record.timings.flatMap((timing) => timing.tokensPerSecond === null ? [] : [timing.tokensPerSecond]);
    if (speeds.length > 0) {
      performance.tokensPerSecondP50 = Math.min(Math.round(percentile(speeds, 0.5)), MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND);
    }
    return performance;
  }
}

function isDuration(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** Nearest-rank percentile of a non-empty list. */
function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

import {
  MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS,
  MAX_SERVICE_PERFORMANCE_REQUESTS,
  MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND,
  SERVICE_PERFORMANCE_WINDOW_MS,
  type ServicePerformance,
} from '../discovery/peer-metadata.js';

/** Newest samples kept per provider and service; `requests` counts at most this many. */
const MAX_SAMPLES = 500;
/** Answers shorter than this say little about streaming speed. */
const MIN_THROUGHPUT_TOKENS = 20;

/** One buyer request a seller relayed upstream. */
export interface ServicePerformanceSample {
  /** False when the upstream failed it (a server-side error, rate limit or exception), not for a client error. */
  ok: boolean;
  /** Time from receiving the request to the first streamed token. Absent for answers that were not streamed. */
  firstTokenMs?: number;
  /** Time from the first streamed token to the end of the answer. */
  streamMs?: number;
  outputTokens?: number;
}

interface Sample {
  at: number;
  ok: boolean;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
}

/**
 * How each service served buyers over the last hour, for the seller to
 * announce: request count, success rate, and first-token time and output
 * speed of streamed answers. Keyed by provider name, so upstreams sharing a
 * name (which must offer a service on the same terms) report one figure.
 */
export class ServicePerformanceTracker {
  private readonly _samples = new Map<string, Sample[]>();

  constructor(private readonly _windowMs = SERVICE_PERFORMANCE_WINDOW_MS) {}

  record(provider: string, service: string, sample: ServicePerformanceSample, now = Date.now()): void {
    const key = `${provider}\u0000${service}`;
    const samples = this._samples.get(key) ?? [];
    const outputTokens = sample.outputTokens ?? 0;
    samples.push({
      at: now,
      ok: sample.ok,
      firstTokenMs: sample.ok && isDuration(sample.firstTokenMs) ? sample.firstTokenMs : null,
      tokensPerSecond: sample.ok && outputTokens >= MIN_THROUGHPUT_TOKENS && isDuration(sample.streamMs) && sample.streamMs > 0
        ? outputTokens / (sample.streamMs / 1000)
        : null,
    });
    if (samples.length > MAX_SAMPLES) samples.splice(0, samples.length - MAX_SAMPLES);
    this._samples.set(key, samples);
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
    const samples = this._samples.get(key);
    if (!samples) return undefined;
    const recent = samples.filter((sample) => now - sample.at < this._windowMs);
    if (recent.length === 0) {
      this._samples.delete(key);
      return undefined;
    }
    if (recent.length < samples.length) this._samples.set(key, recent);
    const ok = recent.filter((sample) => sample.ok).length;
    const performance: ServicePerformance = {
      requests: Math.min(recent.length, MAX_SERVICE_PERFORMANCE_REQUESTS),
      successRate: Math.round((ok / recent.length) * 10_000) / 10_000,
    };
    const firstTokens = recent.flatMap((sample) => sample.firstTokenMs === null ? [] : [sample.firstTokenMs]);
    if (firstTokens.length > 0) {
      performance.firstTokenMsP50 = Math.min(Math.round(percentile(firstTokens, 0.5)), MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
      performance.firstTokenMsP90 = Math.min(Math.round(percentile(firstTokens, 0.9)), MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
    }
    const speeds = recent.flatMap((sample) => sample.tokensPerSecond === null ? [] : [sample.tokensPerSecond]);
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

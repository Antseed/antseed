import {
  MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS,
  MAX_SERVICE_PERFORMANCE_REQUESTS,
  MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND,
  SERVICE_PERFORMANCE_WINDOW_MS,
  type ServicePerformance,
} from '../discovery/peer-metadata.js';

/**
 * The window is kept as fixed slices of running counts, so recording a
 * request is O(1) and a summary sums a few small arrays, whatever the
 * traffic. Sellers rebuild their metadata on every load change, so the
 * summary is also cached until a request lands or a slice expires.
 */
const SLICE_MS = 5 * 60_000;
/** Answers shorter than this say little about streaming speed. */
const MIN_THROUGHPUT_TOKENS = 20;
/**
 * Timings go into log-scale histograms: each bin is 10% wider than the one
 * before, so a reported percentile is within about 5% of the exact value.
 */
const BIN_RATIO = 1.1;
const LOG_BIN_RATIO = Math.log(BIN_RATIO);
const FIRST_TOKEN_BINS = binIndex(MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS) + 1;
const SPEED_BINS = binIndex(MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND) + 1;

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

interface Slice {
  start: number;
  requests: number;
  ok: number;
  /** Allocated on the slice's first timed answer. */
  firstTokens: Uint32Array | null;
  speeds: Uint32Array | null;
}

interface ServiceRecord {
  /** Oldest first; at most one per SLICE_MS in the window. */
  slices: Slice[];
  /** The last summary, valid until `cacheUntil` unless a request lands first. */
  cached: ServicePerformance | null;
  cacheUntil: number;
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
    let record = this._records.get(key);
    if (!record) {
      record = { slices: [], cached: null, cacheUntil: 0 };
      this._records.set(key, record);
    }
    record.cacheUntil = 0;
    const start = now - (now % SLICE_MS);
    let slice = record.slices[record.slices.length - 1];
    if (!slice || slice.start !== start) {
      slice = { start, requests: 0, ok: 0, firstTokens: null, speeds: null };
      record.slices.push(slice);
    }
    slice.requests += 1;
    if (!sample.ok) return;
    slice.ok += 1;
    if (isDuration(sample.firstTokenMs)) {
      (slice.firstTokens ??= new Uint32Array(FIRST_TOKEN_BINS))[Math.min(binIndex(sample.firstTokenMs), FIRST_TOKEN_BINS - 1)]! += 1;
    }
    const outputTokens = sample.outputTokens ?? 0;
    if (outputTokens >= MIN_THROUGHPUT_TOKENS && isDuration(sample.streamMs) && sample.streamMs > 0) {
      const tokensPerSecond = outputTokens / (sample.streamMs / 1000);
      (slice.speeds ??= new Uint32Array(SPEED_BINS))[Math.min(binIndex(tokensPerSecond), SPEED_BINS - 1)]! += 1;
    }
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
    if (now < record.cacheUntil) return record.cached ?? undefined;

    // A slice counts while any of it is inside the window.
    const since = now - this._windowMs;
    while (record.slices.length > 0 && record.slices[0]!.start + SLICE_MS <= since) record.slices.shift();
    if (record.slices.length === 0) {
      this._records.delete(key);
      return undefined;
    }
    let requests = 0;
    let ok = 0;
    const firstTokens = new Uint32Array(FIRST_TOKEN_BINS);
    const speeds = new Uint32Array(SPEED_BINS);
    for (const slice of record.slices) {
      requests += slice.requests;
      ok += slice.ok;
      if (slice.firstTokens) addInto(firstTokens, slice.firstTokens);
      if (slice.speeds) addInto(speeds, slice.speeds);
    }
    const performance: ServicePerformance = {
      requests: Math.min(requests, MAX_SERVICE_PERFORMANCE_REQUESTS),
      successRate: Math.round((ok / requests) * 10_000) / 10_000,
    };
    const firstTokenP50 = histogramPercentile(firstTokens, 0.5);
    if (firstTokenP50 !== null) {
      performance.firstTokenMsP50 = Math.min(firstTokenP50, MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
      performance.firstTokenMsP90 = Math.min(histogramPercentile(firstTokens, 0.9)!, MAX_SERVICE_PERFORMANCE_FIRST_TOKEN_MS);
    }
    const speedP50 = histogramPercentile(speeds, 0.5);
    if (speedP50 !== null) performance.tokensPerSecondP50 = Math.min(speedP50, MAX_SERVICE_PERFORMANCE_TOKENS_PER_SECOND);
    record.cached = performance;
    // Valid until the oldest slice leaves the window.
    record.cacheUntil = record.slices[0]!.start + SLICE_MS + this._windowMs;
    return performance;
  }
}

function binIndex(value: number): number {
  return value < 1 ? 0 : Math.floor(Math.log(value) / LOG_BIN_RATIO) + 1;
}

/** The middle of a bin, on the log scale; bin 0 holds values under 1. */
function binValue(index: number): number {
  return index === 0 ? 0 : Math.round(BIN_RATIO ** (index - 0.5));
}

function addInto(total: Uint32Array, add: Uint32Array): void {
  for (let index = 0; index < add.length; index += 1) total[index]! += add[index]!;
}

/** Nearest-rank percentile of a histogram, or null when it is empty. */
function histogramPercentile(histogram: Uint32Array, fraction: number): number | null {
  let count = 0;
  for (const bin of histogram) count += bin;
  if (count === 0) return null;
  const rank = Math.max(1, Math.ceil(fraction * count));
  let seen = 0;
  for (let index = 0; index < histogram.length; index += 1) {
    seen += histogram[index]!;
    if (seen >= rank) return binValue(index);
  }
  return binValue(histogram.length - 1);
}

function isDuration(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

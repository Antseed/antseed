/** Nearest-rank percentile (p in 0..100) of finite numbers; null when empty. */
export function percentile(values, p) {
  const finite = values.filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (finite.length === 0) return null;
  const sorted = [...finite].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/** Gini coefficient of non-negative values: 0 = perfectly even, (n-1)/n = everything on one. */
export function gini(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const n = sorted.length;
  const total = sorted.reduce((sum, value) => sum + value, 0);
  if (n === 0 || total === 0) return 0;
  let weighted = 0;
  sorted.forEach((value, index) => { weighted += (index + 1) * value; });
  return (2 * weighted) / (n * total) - (n + 1) / n;
}

export function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length ? finite.reduce((sum, value) => sum + value, 0) / finite.length : null;
}

/** Mean with a normal-approximation 95% confidence half-width (t for small n). */
export function meanCi(values) {
  const finite = values.filter(Number.isFinite);
  const n = finite.length;
  if (n === 0) return { n, mean: null, ci95: null, min: null, max: null };
  const avg = mean(finite);
  if (n === 1) return { n, mean: avg, ci95: null, min: avg, max: avg };
  const variance = finite.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (n - 1);
  const T95 = [12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228];
  const t = n - 1 <= T95.length ? T95[n - 2] : 1.96;
  return { n, mean: avg, ci95: t * Math.sqrt(variance / n), min: Math.min(...finite), max: Math.max(...finite) };
}

const round = (value, digits = 1) => (value === null || value === undefined || !Number.isFinite(value) ? null : Number(value.toFixed(digits)));

function group(records) {
  const ok = records.filter((record) => record.ok);
  const errors = {};
  for (const record of records) if (!record.ok) errors[record.errorClass ?? 'unknown'] = (errors[record.errorClass ?? 'unknown'] ?? 0) + 1;
  const ttft = ok.filter((record) => record.stream).map((record) => record.ttftMs);
  const latency = ok.map((record) => record.latencyMs);
  const outputTokens = ok.reduce((sum, record) => sum + (record.usage?.completion_tokens ?? 0), 0);
  const inputTokens = ok.reduce((sum, record) => sum + (record.usage?.prompt_tokens ?? 0), 0);
  const decode = ok.filter((record) => record.stream && record.usage?.completion_tokens > 1 && record.latencyMs > record.ttftMs)
    .map((record) => (record.usage.completion_tokens * 1000) / (record.latencyMs - record.ttftMs));
  const attempted = records.filter((record) => record.errorClass !== 'overload').length;
  return {
    requests: records.length,
    attempted,
    succeeded: ok.length,
    successRate: round(records.length ? ok.length / records.length : null, 4),
    errors,
    retried: records.filter((record) => (record.retries ?? 0) > 0).length,
    ttftMs: { p50: round(percentile(ttft, 50)), p95: round(percentile(ttft, 95)), p99: round(percentile(ttft, 99)) },
    latencyMs: { p50: round(percentile(latency, 50)), p95: round(percentile(latency, 95)), p99: round(percentile(latency, 99)) },
    decodeTokensPerSec: { p50: round(percentile(decode, 50)), p5: round(percentile(decode, 5)) },
    inputTokens,
    outputTokens,
  };
}

/**
 * Workload summary from per-request records. TTFT percentiles cover streaming successes only (for a
 * non-streaming response the first byte is the whole answer, which latency already covers). `wallMs` is the run's wall time; `sellers` lists every
 * seller id (so idle sellers count in the spread); `mockStats` (per seller) adds utilisation;
 * `signedDeltaBySeller` (micro-USDC signed during the run) gives cost per 1M tokens.
 */
export function summarizeWorkload(records, { wallMs, sellers = [], mockStats = {}, signedDeltaBySeller = null, skippedTurns = 0, peakInFlight = null } = {}) {
  const overall = group(records);
  const seconds = Math.max(0.001, (wallMs ?? 1) / 1000);
  overall.outputTokensPerSec = round(overall.outputTokens / seconds, 2);
  overall.requestsPerSec = round(overall.succeeded / seconds, 3);
  overall.dropped = overall.errors.overload ?? 0;
  const personas = {};
  for (const name of [...new Set(records.map((record) => record.persona))].sort()) personas[name] = group(records.filter((record) => record.persona === name));
  const servedBy = {};
  for (const id of sellers) servedBy[id] = 0;
  for (const record of records) if (record.ok && record.sellerId) servedBy[record.sellerId] = (servedBy[record.sellerId] ?? 0) + 1;
  const okTotal = Object.values(servedBy).reduce((sum, value) => sum + value, 0);
  const perSeller = {};
  for (const [id, served] of Object.entries(servedBy)) {
    const stats = mockStats[id];
    const sellerRecords = records.filter((record) => record.sellerId === id);
    perSeller[id] = {
      served,
      share: round(okTotal ? served / okTotal : 0, 4),
      failed: sellerRecords.filter((record) => !record.ok).length,
      ttftP95Ms: round(percentile(sellerRecords.filter((record) => record.ok).map((record) => record.ttftMs), 95)),
      ...(stats ? { utilisation: round(stats.utilisation, 4), peakQueue: stats.peakQueue, upstreamServed: stats.served, upstreamRateLimited: stats.rateLimited } : {}),
    };
  }
  let costPerMillionTokensUsd = null;
  let signedMicroUsdc = null;
  if (signedDeltaBySeller) {
    signedMicroUsdc = Object.values(signedDeltaBySeller).reduce((sum, value) => sum + BigInt(value), 0n);
    const tokens = overall.inputTokens + overall.outputTokens;
    costPerMillionTokensUsd = tokens > 0 ? round(Number(signedMicroUsdc) / tokens, 4) : null;
  }
  return {
    overall: { ...overall, wallMs: Math.round(wallMs ?? 0), skippedTurns, peakInFlight, loadSpreadGini: round(gini(Object.values(servedBy)), 4), signedMicroUsdc: signedMicroUsdc === null ? null : String(signedMicroUsdc), costPerMillionTokensUsd },
    personas,
    sellers: perSeller,
  };
}

/** Flat key -> number view of a summary, used to aggregate repeats. */
export function keyMetrics(summary) {
  const o = summary.overall;
  return {
    successRate: o.successRate,
    ttftP50Ms: o.ttftMs.p50,
    ttftP95Ms: o.ttftMs.p95,
    ttftP99Ms: o.ttftMs.p99,
    latencyP50Ms: o.latencyMs.p50,
    latencyP95Ms: o.latencyMs.p95,
    latencyP99Ms: o.latencyMs.p99,
    outputTokensPerSec: o.outputTokensPerSec,
    dropped: o.dropped,
    loadSpreadGini: o.loadSpreadGini,
    costPerMillionTokensUsd: o.costPerMillionTokensUsd,
  };
}

/** Aggregates numeric metrics across repeats: mean, 95% CI, min, max per key. */
export function aggregateRuns(runs) {
  const keys = new Set(runs.flatMap((run) => Object.keys(run ?? {})));
  const out = {};
  for (const key of [...keys].sort()) {
    const values = runs.map((run) => run?.[key]).filter((value) => typeof value === 'number' && Number.isFinite(value));
    if (values.length === 0) continue;
    const stats = meanCi(values);
    out[key] = { n: stats.n, mean: round(stats.mean, 4), ci95: round(stats.ci95, 4), min: stats.min, max: stats.max };
  }
  return out;
}

/** Flattens nested numeric fields to dotted keys ({ workload: { ttftP95Ms: 1 } } -> { 'workload.ttftP95Ms': 1 }). */
export function flattenNumeric(value, prefix = '', out = {}) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const name = prefix ? `${prefix}.${key}` : key;
    if (typeof child === 'number' && Number.isFinite(child)) out[name] = child;
    else if (typeof child === 'string' && /^-?\d+(\.\d+)?$/.test(child) && child.length < 16) out[name] = Number(child);
    else if (child && typeof child === 'object' && !Array.isArray(child)) flattenNumeric(child, name, out);
  }
  return out;
}

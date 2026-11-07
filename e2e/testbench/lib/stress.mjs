// Load, faults and the payment oracle from the payment stress harness (e2e/stress), as testbench building blocks.
// The testbench owns the network (chain, sellers, buyer, mocks); this module drives traffic through its buyer
// proxy and judges the money with e2e/stress/analysis.mjs, so both harnesses share one set of invariants.
import { AssertionError } from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cliCommandEnv, runCli } from './cli-run.mjs';
import { createPrng, randomTag } from './prng.mjs';

export { analyzePayments, analyzeRecordedCosts } from '../../stress/analysis.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

/** Load shape defaults: the stress harness's BASE (e2e/stress/scenarios.mjs), minus what the topology owns. */
export const LOAD_DEFAULTS = {
  concurrency: 8, requests: 100, streamRatio: 0.5, abortRatio: 0, imageRatio: 0,
  minInTokens: 1000, maxInTokens: 20_000, restart: null,
};

/**
 * Share of requests that must succeed and which failures a load may see, as in e2e/stress/ci.mjs GATES.
 * Every payment violation fails a run regardless of the gate.
 */
export const GATES = {
  default: { minOk: 0.99 },
  faults: { minOk: 0.7, allowedFailures: /^(500:server_error|502:Upstream error: fetch failed|stream-truncated)$/ },
  'restart-buyer': { minOk: 0.85, restart: true },
  'restart-seller': { minOk: 0.75, restart: true },
  'issue-1050': { minOk: 0.95 },
};

/** Log lines that mean a peer crashed (e2e/stress/harness.mjs SELLER_PATTERNS.crash / BUYER_PATTERNS.crash). */
export const CRASH_PATTERN = /Unhandled|uncaught|UnhandledPromiseRejection|FATAL|Segmentation/i;

/** What a seller's log says about a run, counted per line for the report (e2e/stress/harness.mjs SELLER_PATTERNS). */
export const SELLER_PATTERNS = {
  rejectUnderfunded: /Rejecting underfunded SpendingAuth/,
  behindSpendAccepted: /SpendingAuth behind spend, accepted/,
  rejectNonMonotonic: /Rejecting non-monotonic SpendingAuth/,
  rejectOverCeiling: /Rejecting SpendingAuth exceeding deposit ceiling/,
  invalidSig: /Invalid SpendingAuth signature|Invalid reserve batch/,
  failedProcessAuth: /Failed to process SpendingAuth/,
  authRejectedAny: /SpendingAuth.*rejected|rejected.*SpendingAuth/i,
  topUpPermanentFail: /Top-up on-chain failed permanently/,
  topUpDeferred: /Top-up (threshold not met|transaction backpressure)/,
  topUpCompleted: /Top-up completed/,
  catchUpBeforeWait: /catch-up-before-wait/,
  fullyExhausted: /Session fully exhausted/,
  cannotReserveReplacement: /Cannot reserve replacement channel/,
  closingChannel: /Closing channel .* cumulative=/,
  sessionEvicted: /Session evicted during/,
  budget402: /Budget exhausted for .* returning 402/,
  session402: /Session \w+ for .* returning 402/,
  caughtUpBefore402: /Caught up before 402/,
  rejectUnbillable: /Rejecting unbillable request/,
  settleFail: /settle.*fail|Failed to settle|close.*failed/i,
  crash: CRASH_PATTERN,
  typeError: /TypeError|ReferenceError|RangeError/,
};

/** The same for the buyer's log (e2e/stress/harness.mjs BUYER_PATTERNS). */
export const BUYER_PATTERNS = {
  paymentNegotiationFailed: /payment_negotiation_failed/,
  catchUpIncomplete: /catch_up_incomplete/,
  existingChannelStillActive: /existing_channel_still_active/,
  needAuthRejected: /NeedAuth.*reject|NeedAuth rejected/i,
  needAuthStale: /NeedAuth stale/,
  resend: /resending|resendCurrentSpendingAuth|Resending/,
  cannotAdvance: /cannot advance|Cannot extend/,
  overdraft: /overdraft limit reached/,
  capping: /capping at/,
  closeCoop: /Cooperative close/,
  needAuthUnknownChannel: /NeedAuth for unknown channel/,
  needAuthUnknownSeller: /NeedAuth for unknown seller/,
  crash: CRASH_PATTERN,
  typeError: /TypeError|ReferenceError|RangeError/,
};

/** A short, stable failure kind for a non-200 answer (same buckets as the stress harness). */
export function classifyError(status, text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { /* not JSON */ }
  if (parsed) {
    const error = parsed.error;
    if (typeof error === 'string') return `${status}:${error}${parsed.reason ? `/${parsed.reason}` : ''}`;
    if (error && typeof error === 'object') return `${status}:${error.code ?? error.type ?? 'error'}${parsed.reason ? `/${parsed.reason}` : ''}${error.reason ? `/${error.reason}` : ''}`;
    if (parsed.reason) return `${status}:${parsed.reason}`;
  }
  return `${status}:${(text || '').slice(0, 60).replace(/\s+/g, ' ')}`;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

async function imageRequest({ proxyUrl, model }, index, results, { tag, random }) {
  const n = 1 + Math.floor(random() * 2);
  const started = Date.now();
  const record = { i: index, tag, image: true, n, start: started };
  results.push(record);
  try {
    const response = await fetch(`${proxyUrl}/v1/images/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: `[req:${tag}] a small ant carrying a coin, ${'detailed '.repeat(50)}`, n, size: '1024x1024' }),
    });
    record.status = response.status;
    const text = await response.text();
    if (response.status !== 200) { record.error = classifyError(response.status, text); record.body = text.slice(0, 400); }
    else {
      try { const body = JSON.parse(text); if (!Array.isArray(body.data) || body.data.length !== n) record.error = 'image:bad-body'; } catch { record.error = 'image:non-json'; }
    }
  } catch (error) { record.error = `fetch:${error.cause?.code ?? error.name ?? error.message}`; }
  record.ms = Date.now() - started;
  return record;
}

async function chatRequest({ proxyUrl, model, load }, index, results, { tag, random }) {
  const stream = random() < load.streamRatio;
  const abort = random() < load.abortRatio;
  const inTokens = Math.floor(load.minInTokens + random() * (load.maxInTokens - load.minInTokens));
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil((inTokens * 4) / 27)).slice(0, inTokens * 4);
  const body = { model, stream, max_tokens: 4096, messages: [{ role: 'user', content: `[req:${tag}] ${filler}` }] };
  const started = Date.now();
  const controller = new AbortController();
  const record = { i: index, tag, stream, abort, start: started };
  results.push(record);
  try {
    const response = await fetch(`${proxyUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
    record.status = response.status;
    record.provider = response.headers.get('x-antseed-provider');
    record.costHeader = response.headers.get('x-antseed-estimated-cost-usd');
    if (response.status !== 200) {
      const text = await response.text();
      record.error = classifyError(response.status, text);
      record.body = text.slice(0, 400);
    } else if (stream) {
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let chunks = 0;
      const abortAfter = abort ? 1 + Math.floor(random() * 4) : Infinity;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        chunks += 1;
        record.ttfbMs ??= Date.now() - started;
        if (chunks >= abortAfter) { controller.abort(); record.clientAborted = true; break; }
      }
      if (!record.clientAborted) {
        record.sawDone = buffer.includes('[DONE]');
        record.sawUsage = /"usage":\{/.test(buffer);
        if (/"error"/.test(buffer) && !record.sawDone) record.error = `stream-error:${buffer.slice(buffer.lastIndexOf('"error"'), buffer.lastIndexOf('"error"') + 80)}`;
        else if (!record.sawDone) record.error = 'stream-truncated';
      }
    } else if (abort) {
      // Non-streaming client abort: give up after the headers, before the body.
      controller.abort();
      record.clientAborted = true;
    } else {
      const text = await response.text();
      try { const parsed = JSON.parse(text); record.usage = parsed.usage; if (!parsed.choices) record.error = classifyError(200, text); } catch { record.error = '200:non-json'; }
    }
  } catch (error) {
    if (!record.clientAborted) record.error = `fetch:${error.cause?.code ?? error.name ?? error.message}`;
  }
  record.ms = Date.now() - started;
  return record;
}

/**
 * Concurrent paid traffic through the buyer proxy: `concurrency` workers send `requests` tagged requests
 * (`[req:TAG]`, so the mock ledger can say what was delivered), a `streamRatio` share streamed, an `abortRatio`
 * share abandoned by the client, an `imageRatio` share as image generations. `restart` ({ atFraction, run })
 * pauses new requests while `run()` restarts a peer once that share of the load is done; requests already in
 * flight finish or fail on their own. Returns the per-request records, the client summary and restart timing.
 * Each request's tag and draws are fixed up front by its index, so which worker sends it, and when, cannot change them.
 */
export async function runLoad({ proxyUrl, model, imageModel, load: shape = {}, random = Math.random, onRequest }) {
  const load = { ...LOAD_DEFAULTS, ...shape };
  if (load.imageRatio > 0 && !imageModel) throw new Error('imageRatio needs an imageModel');
  const plans = Array.from({ length: load.requests }, () => ({ tag: randomTag(random), random: createPrng(Math.floor(random() * 2 ** 32)) }));
  const results = [];
  const startedAt = Date.now();
  const restartAt = load.restart ? Math.floor(load.requests * load.restart.atFraction) : -1;
  let paused = null;
  let restart = null;
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < load.requests) {
      if (paused) await paused;
      const index = next;
      next += 1;
      const plan = plans[index];
      const record = load.imageRatio > 0 && plan.random() < load.imageRatio
        ? await imageRequest({ proxyUrl, model: imageModel }, index, results, plan)
        : await chatRequest({ proxyUrl, model, load }, index, results, plan);
      done += 1;
      onRequest?.(record);
      if (done === restartAt && !restart) {
        const stoppedAt = Date.now();
        restart = (async () => {
          const info = await load.restart.run();
          return { stoppedAt: stoppedAt - startedAt, downMs: Date.now() - stoppedAt, ...(info ?? {}) };
        })();
        paused = restart.finally(() => { paused = null; });
      }
    }
  };
  await Promise.all(Array.from({ length: load.concurrency }, worker));
  const restartInfo = restart ? await restart : null;
  return { results, startedAt, loadMs: Date.now() - startedAt, restart: restartInfo, client: clientSummary(results, { startedAt, restart: restartInfo }) };
}

/** Sum of the per-request estimated cost headers in USD; null when no request carried one. */
function estimatedCostUsd(results) {
  const costs = results.filter((entry) => entry.costHeader != null).map((entry) => Number(entry.costHeader));
  return costs.length ? Number(costs.reduce((sum, cost) => sum + cost, 0).toFixed(6)) : null;
}

/** Nearest-rank latency percentiles in ms; null with no samples. */
export function latencyPercentiles(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return { p50Ms: percentile(sorted, 50), p95Ms: percentile(sorted, 95), p99Ms: percentile(sorted, 99), maxMs: percentile(sorted, 100) };
}

/** Successful requests per second over the span from the first request's start to the last one's end. */
function okPerSecond(results, okCount) {
  const timed = results.filter((entry) => entry.ms !== undefined);
  if (timed.length === 0) return null;
  const spanMs = timed.reduce((end, entry) => Math.max(end, entry.start + entry.ms), -Infinity) - timed.reduce((start, entry) => Math.min(start, entry.start), Infinity);
  return spanMs > 0 ? Number(((okCount / spanMs) * 1000).toFixed(2)) : null;
}

/**
 * Outcome counts, throughput, estimated cost and latency percentiles over successful requests, overall and split into
 * streamed (with time to first byte) and non-streamed; with a restart, failures inside and outside its window (plus 15 s).
 */
export function clientSummary(results, { startedAt, restart } = {}) {
  const ok = results.filter((entry) => !entry.error && !entry.clientAborted);
  const latencies = (entries) => latencyPercentiles(entries.map((entry) => entry.ms));
  const streamed = ok.filter((entry) => entry.stream);
  const nonStreamed = ok.filter((entry) => !entry.stream);
  const failures = {};
  for (const entry of results) if (entry.error) failures[entry.error] = (failures[entry.error] ?? 0) + 1;
  const summary = {
    total: results.length, ok: ok.length, clientAborted: results.filter((entry) => entry.clientAborted).length,
    failed: results.filter((entry) => entry.error).length, failures,
    ...latencies(ok),
    streamed: { count: streamed.length, ...latencies(streamed), ttfb: latencyPercentiles(streamed.map((entry) => entry.ttfbMs)) },
    nonStreamed: { count: nonStreamed.length, ...latencies(nonStreamed) },
    okPerSecond: okPerSecond(results, ok.length),
    estimatedCostUsd: estimatedCostUsd(results),
  };
  if (restart && startedAt !== undefined) {
    const windowStart = restart.stoppedAt;
    const windowEnd = restart.stoppedAt + restart.downMs + 15_000;
    const inWindow = results.filter((entry) => entry.error && entry.start - startedAt <= windowEnd && entry.start - startedAt + entry.ms >= windowStart);
    summary.failedInRestartWindow = inWindow.length;
    summary.failedOutsideRestartWindow = summary.failed - inWindow.length;
  }
  return summary;
}

/** Problems a client summary has against a gate (empty when it passes): the e2e/stress/ci.mjs evaluate rules. */
export function gateProblems(client, gate = GATES.default) {
  const problems = [];
  const okShare = client.ok / Math.max(1, client.total - client.clientAborted);
  if (okShare < gate.minOk) problems.push(`${client.ok}/${client.total} ok, below the ${Math.round(gate.minOk * 100)}% floor`);
  if (gate.allowedFailures) {
    for (const kind of Object.keys(client.failures)) {
      if (!gate.allowedFailures.test(kind)) problems.push(`unexpected failure kind: ${kind} (${client.failures[kind]})`);
    }
  }
  if (gate.restart && client.failedOutsideRestartWindow) problems.push(`${client.failedOutsideRestartWindow} failures outside the restart window`);
  return problems;
}

let Database;
/** Rows of a node's channel store (payments/sessions.db), read-only; [] while the store does not exist yet. */
export function channelRows(dataDir, role) {
  const file = join(dataDir, 'payments', 'sessions.db');
  if (!existsSync(file)) return [];
  Database ??= createRequire(join(repo, 'packages/node/package.json'))('better-sqlite3');
  const db = new Database(file, { readonly: true, fileMustExist: true, timeout: 5000 });
  try {
    return db.prepare('select session_id, peer_id, role, auth_max, tokens_delivered, status, settled_amount, previous_consumption, request_count from payment_channels where role = ?').all(role);
  } finally {
    db.close();
  }
}

/**
 * Merges per-seller mock ledgers into the `mockStats` shape analyzePayments expects, leaving out tags recorded
 * before the run (`skip`). expectedCostBaseUnits sums the responses delivered in full.
 */
export function mergeDeliveries(ledgers, skip = new Set()) {
  const perRequest = new Map();
  let expectedCostBaseUnits = 0n;
  for (const ledger of ledgers) {
    for (const [tag, entry] of Object.entries(ledger.byTag ?? {})) {
      if (skip.has(tag)) continue;
      perRequest.set(tag, entry);
      if (entry.status === 'ok') expectedCostBaseUnits += BigInt(entry.cost);
    }
  }
  return { perRequest, expectedCostBaseUnits };
}

/**
 * The check on the seller's "Cost recorded" lines: without them the oracle's second opinion is off, so paid requests
 * and no lines fail. Null when no request got through, so no line was due.
 */
export function costLinesCheck(results, lineCount) {
  if (lineCount > 0) return { name: 'seller cost lines compared with settlement', ok: true, detail: { lines: lineCount } };
  const okRequests = results.filter((entry) => !entry.error && !entry.clientAborted).length;
  return okRequests > 0 ? { name: 'seller cost lines missing (ANTSEED_DEBUG not set?)', ok: false, detail: { okRequests } } : null;
}

/**
 * Runs every step even after one throws, then rethrows: the only error as it is, several joined into one. Failed
 * checks joined stay an assertion, so the run is `failed`; with anything else among them the run broke (`error`).
 */
export async function runAll(steps) {
  const errors = [];
  for (const step of steps) {
    try { await step(); } catch (error) { errors.push(error); }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length === 0) return;
  const message = errors.map((error) => error.message).join('\n');
  throw errors.every((error) => error.code === 'ERR_ASSERTION') ? new AssertionError({ message }) : new Error(message);
}

/**
 * Log files under `logsDir`: every `seller-*.log`, the supervisor's, and the buyer's, which is `buyer.log` when the
 * buyer runs as its own process and `supervisor.log` when it runs inside the supervisor. `logs/` outlives a new `up`,
 * so the seller files can include sellers of an earlier topology, and a `buyer.log` that has not grown past
 * `since` (the offsets taken at `up`) belongs to an earlier one.
 */
export function peerLogs(logsDir, since = {}) {
  if (!logsDir || !existsSync(logsDir)) return { all: [], buyer: null };
  const names = readdirSync(logsDir);
  const sellers = names.filter((name) => /^seller-.*\.log$/.test(name));
  const buyerLog = join(logsDir, 'buyer.log');
  const ownBuyerLog = names.includes('buyer.log') && statSync(buyerLog).size > (since[buyerLog] ?? 0);
  const others = ['buyer.log', 'supervisor.log'].filter((name) => names.includes(name));
  return { all: [...others, ...sellers].map((name) => join(logsDir, name)), buyer: ownBuyerLog ? buyerLog : join(logsDir, 'supervisor.log') };
}

/** Byte length of each log so a later scan reads only what this run appended. */
export function logOffsets(files) {
  return Object.fromEntries(files.map((file) => [file, statSync(file, { throwIfNoEntry: false })?.size ?? 0]));
}

/** A log's text from byte `start`; empty when the file is missing. */
export async function readLog(file, start = 0) {
  const handle = await open(file, 'r').catch(() => null);
  if (!handle) return '';
  try {
    const { size } = await handle.stat();
    if (size <= start) return '';
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

/** Lines matching `pattern` written to `files` since `offsets` (at most `limit` examples per file). */
export async function scanLogs(files, offsets, pattern, limit = 3) {
  const hits = {};
  for (const file of files) {
    const lines = (await readLog(file, offsets?.[file])).split('\n').filter((line) => pattern.test(line));
    if (lines.length) hits[file] = { count: lines.length, examples: lines.slice(0, limit).map((line) => line.slice(0, 400)) };
  }
  return hits;
}

/** Lines per named pattern in what `files` gained since `offsets`; one line can count toward several patterns. */
export async function countPatterns(files, offsets, patterns) {
  const counts = Object.fromEntries(Object.keys(patterns).map((name) => [name, 0]));
  for (const file of files) {
    for (const line of (await readLog(file, offsets?.[file])).split('\n')) {
      for (const [name, pattern] of Object.entries(patterns)) if (pattern.test(line)) counts[name] += 1;
    }
  }
  return counts;
}

/** Distinct non-loopback IPv4 hosts of the URLs in a log (first five): the stress harness's isolation leak. */
export function externalHosts(text) {
  const hosts = [...text.matchAll(/https?:\/\/(\d+\.\d+\.\d+\.\d+)/g)].map((match) => match[1]);
  return [...new Set(hosts.filter((ip) => !ip.startsWith('127.')))].slice(0, 5);
}

/** Bootstrap node count of every node start a log records. The line is a debug line (ANTSEED_DEBUG). */
export function bootstrapCounts(text) {
  return [...text.matchAll(/Starting as \w+ with (\d+) bootstrap node/g)].map((match) => Number(match[1]));
}

// ── Stress scenarios on the testbench ───────────────────────────────────────

export const STRESS_MODEL = 'mock-model';
export const STRESS_IMAGE_MODEL = 'qwen-image';
const DEBUG_ENV = { ANTSEED_DEBUG: '1' };

/**
 * The payment stress harness's network as a testbench topology: one seller with its pricing (3 / 15 USD per
 * million tokens, 0.04 USD per image) on a load-profile mock, a 500 USDC buyer deposit with a 1 USDC reserve
 * cap, Base-like RPC links with 2 s blocks, Base's 65% top-up threshold, a 15 s idle settle and the CLI
 * seller's 0.01 USDC minimum budget per request. Every node runs with ANTSEED_DEBUG, as in the harness: the oracle's
 * cost lines, the isolation check's bootstrap lines and most of metrics.logPatterns are debug lines.
 * Overrides merge per section.
 */
// Stress shapes run the real `antseed` processes (cli mode) by default, like the e2e/stress harness they replace.
export function stressTopology({ mode = 'cli', seller = {}, buyer = {}, chain = {}, payments = {}, budgets } = {}) {
  return {
    mode,
    ...(budgets ? { budgets } : {}),
    sellers: [{
      id: 'seller',
      providers: {
        mock: {
          plugin: 'openai',
          defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
          services: {
            [STRESS_MODEL]: { categories: ['chat'], pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
            [STRESS_IMAGE_MODEL]: {
              pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
              capabilities: { inputs: ['text'], outputs: ['image'] },
              unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
            },
          },
        },
      },
      ...seller,
      mock: { usage: 'load', ...(seller.mock ?? {}) },
      env: { ...DEBUG_ENV, ...(seller.env ?? {}) },
    }],
    buyer: { depositUsdc: '500', maxReserveUsdc: '1', maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } }, ...buyer, env: { ...DEBUG_ENV, ...(buyer.env ?? {}) } },
    chain: { rpc: 'base', topUpThresholdBps: 6500, ...chain },
    // The stress harness runs `antseed seller start`, whose minimum budget per request is 0.01 USDC.
    payments: { settlementIdleMs: 15_000, minBudgetPerRequestUsdc: '0.01', ...payments },
  };
}

/** One small paid request that must succeed before the load (opens the channel), retried while the network settles. */
export async function warmUp(tb, model = STRESS_MODEL) {
  const random = tb.prng('warm-up');
  return tb.waitFor(async () => {
    try {
      return await tb.chat({ model, prompt: `[req:warm-${randomTag(random, 8)}] hi` });
    } catch {
      return false;
    }
  }, 'a warm-up request to succeed', { timeoutMs: 120_000, intervalMs: 2000 });
}

/** What one load measured, flat, for tb.timings and drift. */
export function loadTimings({ client, restart, loadMs }) {
  return {
    p50Ms: client.p50Ms, p95Ms: client.p95Ms, p99Ms: client.p99Ms, maxMs: client.maxMs,
    streamedP95Ms: client.streamed.p95Ms, nonStreamedP95Ms: client.nonStreamed.p95Ms, ttfbP95Ms: client.streamed.ttfb.p95Ms,
    okPerSecond: client.okPerSecond, loadMs,
    ...(restart ? { restartDownMs: restart.downMs, settleOnDisconnectMs: restart.settleOnDisconnectMs } : {}),
  };
}

/**
 * A payment stress scenario end to end on the testbench: snapshot, warm-up, faults on, load, faults off, then the
 * payment oracle, the crash and isolation checks, the load gate and `topology.budgets`. `faults` are mock fault rates for the load phase
 * only. A failed gate or check never hides another: every verdict is recorded before the run fails.
 */
export async function stressRun(tb, { load, faults, gate = GATES.default, sellerId = 'seller' }) {
  const before = await tb.paymentSnapshot();
  await warmUp(tb);
  let run;
  await runAll([
    async () => {
      try {
        if (faults) await tb.setMockFaults(sellerId, faults);
        run = await tb.load({ model: STRESS_MODEL, ...(load.imageRatio ? { imageModel: STRESS_IMAGE_MODEL } : {}), gate, ...load });
      } finally {
        if (faults) await tb.setMockFaults(sellerId, { fault500Rate: 0, disconnectRate: 0 });
      }
    },
    // A load that threw left no results to judge; the crash scan can still say why.
    () => run && tb.assertDeliveredWorkPaid({ before, results: run.results, injected: { ...(faults ?? {}), abortRatio: load.abortRatio ?? 0, restart: load.restart ?? null } }),
    () => tb.assertNoCrashes(),
    () => run && tb.checkGate(run),
    () => run && tb.timings(loadTimings(run)),
  ]);
  return run;
}

/** Finds the first numeric `key` anywhere in a JSON value. */
export function findNumber(value, key) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value[key] === 'number') return value[key];
  for (const nested of Object.values(value)) {
    const found = findNumber(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * `antseed buyer status --json`'s active-channel count for a buyer data dir, from this worktree's CLI with the
 * testbench HOME and the official bootstrap list emptied (lib/cli-run.mjs). { count } or { error }. `run` is the
 * CLI runner (tb.cli); without one the command runs directly, unrecorded.
 */
export async function cliActiveChannels({ home, dataDir, configPath, env = process.env, run }) {
  const args = ['buyer', 'status', '--json'];
  const options = { dataDir, configPath, timeoutMs: 120_000 };
  const result = run
    ? await run(args, { ...options, home })
    : await runCli({ entry: join(repo, 'apps/cli/dist/cli/index.js'), args, ...options, env: cliCommandEnv(env, home) });
  if (result.code !== 0) return { error: `exit ${result.code ?? result.signal}${result.stderr.trim() ? `: ${result.stderr.trim().slice(-300)}` : ''}` };
  let json = result.json;
  if (json === null) try { json = JSON.parse(result.stdout.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { /* not JSON */ }
  return typeof json?.activeChannels === 'number' ? { count: json.activeChannels } : { error: 'no activeChannels in the output' };
}

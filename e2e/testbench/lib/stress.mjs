// Load, faults and the payment oracle from the payment stress harness (e2e/stress), as testbench building blocks.
// The testbench owns the network (chain, sellers, buyer, mocks); this module drives traffic through its buyer
// proxy and judges the money with e2e/stress/analysis.mjs, so both harnesses share one set of invariants.
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

async function imageRequest({ proxyUrl, model }, index, results, random) {
  const tag = randomUUID().slice(0, 13);
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

async function chatRequest({ proxyUrl, model, load }, index, results, random) {
  const tag = randomUUID().slice(0, 13);
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
 */
export async function runLoad({ proxyUrl, model, imageModel, load: shape = {}, random = Math.random, onRequest }) {
  const load = { ...LOAD_DEFAULTS, ...shape };
  if (load.imageRatio > 0 && !imageModel) throw new Error('imageRatio needs an imageModel');
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
      const record = load.imageRatio > 0 && random() < load.imageRatio
        ? await imageRequest({ proxyUrl, model: imageModel }, index, results, random)
        : await chatRequest({ proxyUrl, model, load }, index, results, random);
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

/** Outcome counts and latency percentiles; with a restart, failures inside and outside its window (plus 15 s). */
export function clientSummary(results, { startedAt, restart } = {}) {
  const ok = results.filter((entry) => !entry.error && !entry.clientAborted);
  const latencies = ok.map((entry) => entry.ms).sort((a, b) => a - b);
  const failures = {};
  for (const entry of results) if (entry.error) failures[entry.error] = (failures[entry.error] ?? 0) + 1;
  const summary = {
    total: results.length, ok: ok.length, clientAborted: results.filter((entry) => entry.clientAborted).length,
    failed: results.filter((entry) => entry.error).length, failures,
    p50: percentile(latencies, 50), p95: percentile(latencies, 95), max: percentile(latencies, 100),
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

/** Byte length of each log so a later scan reads only what this run appended. */
export async function logOffsets(files) {
  const offsets = {};
  for (const file of files) offsets[file] = (await stat(file).catch(() => null))?.size ?? 0;
  return offsets;
}

/** Lines matching `pattern` written to `files` since `offsets` (at most `limit` examples per file). */
export async function scanLogs(files, offsets, pattern, limit = 3) {
  const hits = {};
  for (const file of files) {
    const handle = await open(file, 'r').catch(() => null);
    if (!handle) continue;
    try {
      const start = offsets?.[file] ?? 0;
      const { size } = await handle.stat();
      if (size <= start) continue;
      const buffer = Buffer.alloc(size - start);
      await handle.read(buffer, 0, buffer.length, start);
      const lines = buffer.toString('utf8').split('\n').filter((line) => pattern.test(line));
      if (lines.length) hits[file] = { count: lines.length, examples: lines.slice(0, limit).map((line) => line.slice(0, 400)) };
    } finally {
      await handle.close();
    }
  }
  return hits;
}

// ── Stress scenarios on the testbench ───────────────────────────────────────

export const STRESS_MODEL = 'mock-model';
export const STRESS_IMAGE_MODEL = 'qwen-image';

/**
 * The payment stress harness's network as a testbench topology: one seller with its pricing (3 / 15 USD per
 * million tokens, 0.04 USD per image) on a load-profile mock, a 500 USDC buyer deposit with a 1 USDC reserve
 * cap, Base-like RPC links with 2 s blocks, Base's 65% top-up threshold, a 15 s idle settle and the CLI
 * seller's 0.01 USDC minimum budget per request.
 * Overrides merge per section.
 */
export function stressTopology({ seller = {}, buyer = {}, chain = {}, payments = {} } = {}) {
  return {
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
    }],
    buyer: { depositUsdc: '500', maxReserveUsdc: '1', maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } }, ...buyer },
    chain: { rpc: 'base', topUpThresholdBps: 6500, ...chain },
    // The stress harness runs `antseed seller start`, whose minimum budget per request is 0.01 USDC.
    payments: { settlementIdleMs: 15_000, minBudgetPerRequestUsdc: '0.01', ...payments },
  };
}

/** One small paid request that must succeed before the load (opens the channel), retried while the network settles. */
export async function warmUp(tb, model = STRESS_MODEL) {
  return tb.waitFor(async () => {
    try {
      return await tb.chat({ model, prompt: `[req:warm-${randomUUID().slice(0, 8)}] hi` });
    } catch {
      return false;
    }
  }, 'a warm-up request to succeed', { timeoutMs: 120_000, intervalMs: 2000 });
}

/**
 * A payment stress scenario end to end on the testbench: snapshot, warm-up, faults on, load (gated), faults off,
 * then the payment oracle and the crash checks. `faults` are mock fault rates for the load phase only.
 */
export async function stressRun(tb, { load, faults, gate = GATES.default, sellerId = 'seller' }) {
  const before = await tb.paymentSnapshot();
  await warmUp(tb);
  if (faults) await tb.setMockFaults(sellerId, faults);
  const run = await tb.load({ model: STRESS_MODEL, ...(load.imageRatio ? { imageModel: STRESS_IMAGE_MODEL } : {}), gate, ...load });
  if (faults) await tb.setMockFaults(sellerId, { fault500Rate: 0, disconnectRate: 0 });
  await tb.assertDeliveredWorkPaid({ before, results: run.results, injected: { ...(faults ?? {}), abortRatio: load.abortRatio ?? 0, restart: load.restart ?? null } });
  await tb.assertNoCrashes();
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
 * testbench HOME and the official bootstrap list emptied (e2e/stress/isolate.mjs). { count } or { error }.
 */
export async function cliActiveChannels({ home, dataDir, configPath, env = process.env }) {
  const { spawn } = await import('node:child_process');
  const { isolatedEnv } = await import('./env.mjs');
  const { pathToFileURL } = await import('node:url');
  const isolate = pathToFileURL(join(repo, 'e2e/stress/isolate.mjs')).href;
  return new Promise((resolveCli) => {
    const child = spawn(process.execPath, [join(repo, 'apps/cli/dist/cli/index.js'), '--data-dir', dataDir, '--config', configPath, 'buyer', 'status', '--json'], {
      env: isolatedEnv(env, home, { ANTSEED_NO_UPDATE_CHECK: '1', NODE_OPTIONS: `--import ${isolate}`, STRESS_NODE_DIST: join(repo, 'packages/node/dist') }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolveCli({ error: `exit ${code}${stderr.trim() ? `: ${stderr.trim().slice(-300)}` : ''}` });
      let json = null;
      try { json = JSON.parse(stdout.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch { /* not JSON */ }
      resolveCli(typeof json?.activeChannels === 'number' ? { count: json.activeChannels } : { error: 'no activeChannels in the output' });
    });
  });
}

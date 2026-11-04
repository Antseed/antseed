#!/usr/bin/env node
// Payment-channel stress harness: the real CLI seller and buyer proxy, a
// mock OpenAI-compatible upstream, and the repo's contracts on anvil behind
// Base-like RPCs. See README.md.
//
// usage: node harness.mjs --scenario <name> [--runs N] [--label L] [--slot N]
//                         [--tree <repo>] [--seller-tree <repo>] [--buyer-tree <repo>]
//                         [--rpc base|anvil] [--out <dir>] [--port-base N]
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync, appendFileSync, createWriteStream, rmSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { freshChain, chainSnapshot, readChannel, ADDR, KEYS, C } from './chain.mjs';
import { startMockUpstream } from './mock-upstream.mjs';
import { startRpcProxy } from './rpc-proxy.mjs';
import { SCENARIOS } from './scenarios.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO = resolve(HERE, '../..');
const CONTRACTS_DIR = join(REPO, 'packages/contracts');
const SELLER_PEER = ADDR.seller.toLowerCase().slice(2);

// ── Utilities ───────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}
function pct(arr, p) {
  if (arr.length === 0) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}
const Database = createRequire(join(REPO, 'packages/node/package.json'))('better-sqlite3');
function sqliteJson(db, sql) {
  if (!existsSync(db)) return [];
  const conn = new Database(db, { readonly: true, timeout: 5000 });
  try { return conn.prepare(sql).all(); } finally { conn.close(); }
}

const SLOT = Number(arg('slot', '0'));
// Each slot takes ten ports from --port-base.
const PB = Number(arg('port-base', '27545')) + SLOT * 10;
const PORTS = { anvil: PB, bootstrap: PB + 1, sellerDht: PB + 2, sellerSig: PB + 3, buyerProxy: PB + 4, sellerRpc: PB + 5, buyerRpc: PB + 6 };
// base (default): Base-like RPCs (latency, 429s, lagging reads, 2 s blocks) between the peers and anvil.
const RPC_PROFILE = arg('rpc', 'base');
const OUT = resolve(arg('out', join(tmpdir(), 'antseed-stress')));
const STATE_FILE = join(OUT, 'chain-state.json');
function treeInfo(tree) {
  const head = spawnSync('git', ['-C', tree, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = spawnSync('git', ['-C', tree, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim().length > 0;
  const built = statSync(join(tree, 'packages/node/dist/index.js'), { throwIfNoEntry: false })?.mtime.toISOString().slice(11, 19);
  return `${head}${dirty ? '+dirty' : ''}@node-dist-${built ?? 'missing'}`;
}

function linkPlugins(home, tree) {
  const dir = join(home, '.antseed', 'plugins', 'node_modules', '@antseed');
  mkdirSync(dir, { recursive: true });
  for (const p of ['provider-openai', 'router-local']) {
    const target = join(tree, 'plugins', p);
    const link = join(dir, p);
    if (!existsSync(link)) symlinkSync(target, link);
  }
}

function cryptoConfig(rpc) {
  return {
    chainId: 'base-local', rpcUrl: rpc,
    depositsContractAddress: C.deposits, channelsContractAddress: C.channels,
    stakingContractAddress: C.staking, usdcContractAddress: C.usdc,
    identityRegistryAddress: C.identity, depositRelayAddress: C.depositRelay,
    registryContractAddress: C.registry, emissionsContractAddress: C.emissions,
  };
}

function writeSellerConfig(dir, rpc, mockPort, sc) {
  const services = {
    'mock-model': { upstreamModel: 'mock-upstream', pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
  };
  if (sc.imageRatio > 0) {
    services['qwen-image'] = {
      upstreamModel: 'qwen-image',
      pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      capabilities: { inputs: ['text'], outputs: ['image'] },
      unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
    };
  }
  const cfg = {
    identity: { displayName: 'Stress Seller' },
    seller: {
      maxConcurrentBuyers: 256, reserveFloor: 0, publicAddress: `127.0.0.1:${PORTS.sellerSig}`,
      providers: {
        mock: {
          plugin: 'openai', baseUrl: `http://127.0.0.1:${mockPort}`, apiKeyEnv: 'MOCK_API_KEY',
          defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
          services,
        },
      },
      healthCheck: { enabled: false }, gasCheck: { enabled: false }, gasRefuel: { enabled: false },
      restrictedCountries: [],
    },
    payments: { preferredMethod: 'crypto', crypto: cryptoConfig(rpc) },
    relayer: { enabled: false },
    network: { bootstrapNodes: [`127.0.0.1:${PORTS.bootstrap}`] },
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, 'identity.key'), KEYS.seller.slice(2));
}

function writeBuyerConfig(dir, rpc, sc) {
  const cfg = {
    identity: { displayName: 'Stress Buyer' },
    buyer: {
      proxyPort: PORTS.buyerProxy, autoSweep: false,
      maxPricing: { defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
    },
    payments: {
      preferredMethod: 'crypto', crypto: cryptoConfig(rpc),
      maxReserveAmountUsdc: sc.maxReserveUsdc,
      ...(sc.maxPerRequestUsdc ? { maxPerRequestUsdc: sc.maxPerRequestUsdc } : {}),
    },
    network: { bootstrapNodes: [`127.0.0.1:${PORTS.bootstrap}`] },
  };
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  writeFileSync(join(dir, 'identity.key'), KEYS.buyer.slice(2));
}

class Proc {
  constructor(name, cmd, args, env, logFile) {
    this.name = name; this.cmd = cmd; this.args = args; this.env = env; this.logFile = logFile;
    this.exits = [];
  }
  start() {
    const out = createWriteStream(this.logFile, { flags: 'a' });
    out.write(`\n===== [harness] start ${this.name} at ${new Date().toISOString()} =====\n`);
    this.child = spawn(this.cmd, this.args, { env: this.env, stdio: ['ignore', 'pipe', 'pipe'] });
    // Prefix every line with a wall-clock timestamp so seller and buyer logs can be aligned.
    for (const stream of [this.child.stdout, this.child.stderr]) {
      let buf = '';
      stream.setEncoding('utf8');
      stream.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) { out.write(`${new Date().toISOString().slice(11, 23)} ${buf.slice(0, i)}\n`); buf = buf.slice(i + 1); }
      });
      stream.on('end', () => { if (buf) out.write(`${new Date().toISOString().slice(11, 23)} ${buf}\n`); });
    }
    this.alive = true;
    this.child.on('exit', (code, sig) => {
      this.alive = false;
      this.exits.push({ code, sig, at: Date.now(), expected: !!this.stopping });
      out.write(`\n===== [harness] ${this.name} exited code=${code} sig=${sig} =====\n`);
    });
  }
  async stop(timeoutMs = 20000) {
    if (!this.alive) return { forced: false };
    this.stopping = true;
    this.child.kill('SIGTERM');
    const t0 = Date.now();
    while (this.alive && Date.now() - t0 < timeoutMs) await sleep(100);
    let forced = false;
    if (this.alive) { forced = true; this.child.kill('SIGKILL'); while (this.alive) await sleep(50); }
    this.stopping = false;
    return { forced, ms: Date.now() - t0 };
  }
}

/** The CLI of `tree` on a peer's data dir, kept on the local DHT by isolate.mjs. */
function cliInvocation(tree, dataDir, home, args, extraEnv = {}) {
  return {
    cmd: process.execPath,
    args: [join(tree, 'apps/cli/dist/cli/index.js'), '--data-dir', dataDir, '--config', join(dataDir, 'config.json'), ...args],
    env: {
      PATH: process.env.PATH, HOME: home,
      ANTSEED_NO_UPDATE_CHECK: '1', ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1',
      NODE_OPTIONS: `--import ${pathToFileURL(join(HERE, 'isolate.mjs')).href}`,
      STRESS_NODE_DIST: join(tree, 'packages/node/dist'),
      ...extraEnv,
    },
  };
}

function cliProc(name, tree, dataDir, home, cmdArgs, logFile, extraEnv = {}) {
  const { cmd, args, env } = cliInvocation(tree, dataDir, home, ['--verbose', ...cmdArgs], {
    ANTSEED_DEBUG: '1', MOCK_API_KEY: 'sk-mock',
    NODE_OPTIONS: `--unhandled-rejections=warn --import ${pathToFileURL(join(HERE, 'isolate.mjs')).href}`,
    ...extraEnv,
  });
  return new Proc(name, cmd, args, env, logFile);
}

async function waitFor(fn, label, timeoutMs, interval = 500) {
  const t0 = Date.now();
  let last;
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v; } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label}${last ? `: ${last.message}` : ''}`);
}

// ── Load ────────────────────────────────────────────────────────────────
function classifyError(status, text) {
  let j;
  try { j = JSON.parse(text); } catch {}
  if (j) {
    const e = j.error;
    if (typeof e === 'string') return `${status}:${e}${j.reason ? '/' + j.reason : ''}`;
    if (e && typeof e === 'object') return `${status}:${e.code ?? e.type ?? 'error'}${j.reason ? '/' + j.reason : ''}${e.reason ? '/' + e.reason : ''}`;
    if (j.reason) return `${status}:${j.reason}`;
  }
  return `${status}:${(text || '').slice(0, 60).replace(/\s+/g, ' ')}`;
}

async function imageRequest(sc, i, results) {
  const tag = randomUUID().slice(0, 13);
  const n = 1 + Math.floor(Math.random() * 2);
  const t0 = Date.now();
  const rec = { i, tag, image: true, n, start: t0 };
  results.push(rec);
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/v1/images/generations`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'qwen-image', prompt: `[req:${tag}] a small ant carrying a coin, ${'detailed '.repeat(50)}`, n, size: '1024x1024' }),
    });
    rec.status = res.status;
    const text = await res.text();
    if (res.status !== 200) { rec.error = classifyError(res.status, text); rec.body = text.slice(0, 400); }
    else { try { const j = JSON.parse(text); if (!Array.isArray(j.data) || j.data.length !== n) rec.error = 'image:bad-body'; } catch { rec.error = 'image:non-json'; } }
  } catch (err) { rec.error = `fetch:${err.cause?.code ?? err.name ?? err.message}`; }
  rec.ms = Date.now() - t0;
  return rec;
}

async function oneRequest(sc, i, results) {
  if (sc.imageRatio > 0 && Math.random() < sc.imageRatio) return imageRequest(sc, i, results);
  const tag = randomUUID().slice(0, 13);
  const stream = Math.random() < sc.streamRatio;
  const abort = Math.random() < sc.abortRatio;
  const inTokens = Math.floor(sc.minInTokens + Math.random() * (sc.maxInTokens - sc.minInTokens));
  const filler = 'lorem ipsum dolor sit amet '.repeat(Math.ceil((inTokens * 4) / 27)).slice(0, inTokens * 4);
  const body = {
    model: 'mock-model', stream, max_tokens: 4096,
    messages: [{ role: 'user', content: `[req:${tag}] ${filler}` }],
  };
  const t0 = Date.now();
  const ctrl = new AbortController();
  const rec = { i, tag, stream, abort, start: t0 };
  results.push(rec);
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    rec.status = res.status;
    rec.costHeader = res.headers.get('x-antseed-estimated-cost-usd');
    if (res.status !== 200) {
      const text = await res.text();
      rec.error = classifyError(res.status, text);
      rec.body = text.slice(0, 400);
    } else if (stream) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = ''; let chunks = 0;
      const abortAfter = abort ? 1 + Math.floor(Math.random() * 4) : Infinity;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        chunks++;
        if (chunks >= abortAfter) { ctrl.abort(); rec.clientAborted = true; break; }
      }
      if (!rec.clientAborted) {
        rec.sawDone = buf.includes('[DONE]');
        const usage = buf.match(/"usage":\{[^}]*\}/g);
        rec.sawUsage = !!usage;
        if (/"error"/.test(buf) && !rec.sawDone) { rec.error = `stream-error:${buf.slice(buf.lastIndexOf('"error"'), buf.lastIndexOf('"error"') + 80)}`; }
        else if (!rec.sawDone) rec.error = 'stream-truncated';
      }
    } else {
      if (abort) {
        // Non-streaming client abort: give up before the body arrives (headers already in).
        ctrl.abort(); rec.clientAborted = true;
      } else {
        const text = await res.text();
        try { const j = JSON.parse(text); rec.usage = j.usage; if (!j.choices) rec.error = classifyError(200, text); } catch { rec.error = '200:non-json'; }
      }
    }
  } catch (err) {
    if (rec.clientAborted) {} else rec.error = `fetch:${err.cause?.code ?? err.name ?? err.message}`;
  }
  rec.ms = Date.now() - t0;
  return rec;
}

const LOAD_STATE = { restarting: null };
async function runLoad(sc, results, onProgress) {
  let next = 0; let done = 0;
  const worker = async () => {
    while (next < sc.requests) {
      // Clients back off while a process restarts (in-flight requests still fail/resume naturally).
      if (LOAD_STATE.restarting) await LOAD_STATE.restarting;
      const i = next++;
      await oneRequest(sc, i, results);
      done++;
      onProgress?.(done);
    }
  };
  await Promise.all(Array.from({ length: sc.concurrency }, worker));
}

// ── Log analysis ────────────────────────────────────────────────────────
const SELLER_PATTERNS = {
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
  crash: /Unhandled|uncaught|UnhandledPromiseRejection|FATAL|Segmentation/i,
  typeError: /TypeError|ReferenceError|RangeError/,
};
const BUYER_PATTERNS = {
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
  crash: /Unhandled|uncaught|UnhandledPromiseRejection|FATAL|Segmentation/i,
  typeError: /TypeError|ReferenceError|RangeError/,
};
function scanLog(file, patterns) {
  const counts = {}; const ex = {};
  for (const k of Object.keys(patterns)) { counts[k] = 0; ex[k] = []; }
  if (!existsSync(file)) return { counts, ex };
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    for (const [k, re] of Object.entries(patterns)) {
      if (re.test(line)) { counts[k]++; if (ex[k].length < 3) ex[k].push(line.slice(0, 400)); }
    }
  }
  return { counts, ex };
}

// ── #1050: stale active channels after a seller-side close ─────────────
function buyerActiveRows(buyerDb) {
  return sqliteJson(buyerDb, "select session_id, status from payment_channels where role='buyer' and status='active'");
}
function findNumber(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (typeof obj[key] === 'number') return obj[key];
  for (const v of Object.values(obj)) { const n = findNumber(v, key); if (n !== undefined) return n; }
  return undefined;
}
// Async: the RPC proxies live in this process, so a sync spawn would starve them.
// Resolves with the exit code, the JSON object it printed (null if none), and its stderr tail.
function cliJson(tree, dataDir, home, args) {
  return new Promise((resolveCli) => {
    const { cmd, args: argv, env } = cliInvocation(tree, dataDir, home, args);
    const child = spawn(cmd, argv, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('exit', (code) => {
      clearTimeout(timer);
      let json = null;
      try { json = JSON.parse(stdout.match(/\{[\s\S]*\}/)?.[0] ?? 'null'); } catch {}
      resolveCli({ code, json, stderr: stderr.trim().slice(-300) || undefined });
    });
  });
}

/** `buyer status --json`'s active-channel count, or why it could not be read. */
async function cliActiveChannels(tree, dataDir, home) {
  const { code, json, stderr } = await cliJson(tree, dataDir, home, ['buyer', 'status', '--json']);
  if (code !== 0) return { error: `exit ${code}${stderr ? `: ${stderr}` : ''}` };
  return typeof json?.activeChannels === 'number' ? { count: json.activeChannels } : { error: 'no activeChannels in the output' };
}

/** GET a buyer-proxy route as JSON, or why it failed. */
async function proxyJson(path) {
  try {
    const res = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}${path}`);
    if (!res.ok) return { error: `HTTP ${res.status}` };
    return { json: await res.json() };
  } catch (e) {
    return { error: e.message };
  }
}
async function stale1050Phase({ sc, seller, buyer, buyerDir, buyerTree, buyerHome, rpc, result }) {
  const buyerDb = join(buyerDir, 'payments', 'sessions.db');
  const out = { t: {} };
  const t0 = Date.now();
  await sleep(5000); // let post-response auths land
  const before = buyerActiveRows(buyerDb).map((r) => r.session_id);
  out.activeBeforeStop = before.length;
  // Buyer goes away; the seller closes the channel on disconnect.
  await buyer.stop();
  await waitFor(() => before.every((id) => readChannel(rpc, id).status !== 1), 'seller close on-chain', 180_000, 2000)
    .catch((e) => result.notes.push(`1050 close wait: ${e.message}`));
  out.t.closedOnChainMs = Date.now() - t0;
  out.onchainStatus = Object.fromEntries(before.map((id) => [id.slice(0, 10), readChannel(rpc, id).status]));
  out.staleRowsWhileStopped = buyerActiveRows(buyerDb).filter((r) => before.includes(r.session_id)).length;
  // Offline CLI count (no running buyer).
  out.cliStatusStopped = await cliActiveChannels(buyerTree, buyerDir, buyerHome);
  await sleep(8000);
  out.cliStatusStopped2 = await cliActiveChannels(buyerTree, buyerDir, buyerHome);
  // Buyer comes back without talking to that seller.
  buyer.start();
  await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/status`)).ok, 'buyer restart', 60_000, 250);
  const t1 = Date.now();
  let stale = -1;
  await waitFor(() => { stale = buyerActiveRows(buyerDb).filter((r) => before.includes(r.session_id)).length; return stale === 0; },
    'buyer retires closed rows', sc.stale1050.reconcileWaitMs, 1000).catch(() => {});
  out.t.retiredAfterRestartMs = stale === 0 ? Date.now() - t1 : null;
  out.staleRowsAfterRestart = stale;
  const usage = await proxyJson('/_antseed/buyer-usage');
  const usageCount = findNumber(usage.json, 'activeChannels');
  out.usageActiveChannels = typeof usageCount === 'number' ? { count: usageCount } : { error: usage.error ?? 'no activeChannels in the response' };
  const channels = await proxyJson('/_antseed/channels');
  out.channelsView = Array.isArray(channels.json?.channels) ? { count: channels.json.channels.length } : { error: channels.error ?? 'no channels in the response' };
  out.cliStatusRunning = await cliActiveChannels(buyerTree, buyerDir, buyerHome);
  out.rowStatuses = sqliteJson(buyerDb, "select substr(session_id,1,10) id, status, settled_amount, auth_max from payment_channels where role='buyer'");
  if (out.staleRowsAfterRestart !== 0) result.violations.push({ kind: '1050-stale-active-rows-after-restart', n: out.staleRowsAfterRestart });
  // Every surface must answer, and answer 0: a missing count is not a pass.
  for (const [surface, read] of [['usage', out.usageActiveChannels], ['channels-view', out.channelsView], ['cli-status', out.cliStatusRunning]]) {
    if (read.error) result.violations.push({ kind: `1050-${surface}-unreadable`, error: read.error });
    else if (read.count !== 0) result.violations.push({ kind: `1050-${surface}-counts-closed-channels`, n: read.count });
  }
  for (const read of [out.cliStatusStopped, out.cliStatusStopped2]) {
    if (read.error) result.violations.push({ kind: '1050-offline-cli-status-unreadable', error: read.error });
  }
  if (out.cliStatusStopped2.count) result.notes.push(`1050: offline buyer status counted ${out.cliStatusStopped2.count}`);
  return out;
}

// ── One run ─────────────────────────────────────────────────────────────
async function oneRun({ scenarioName, sc, sellerTree, buyerTree, runDir }) {
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const sellerDir = join(runDir, 'seller'); const buyerDir = join(runDir, 'buyer');
  const sellerHome = join(runDir, 'home-seller'); const buyerHome = join(runDir, 'home-buyer');
  for (const d of [sellerDir, buyerDir, sellerHome, buyerHome]) mkdirSync(d, { recursive: true });
  linkPlugins(sellerHome, sellerTree); linkPlugins(buyerHome, buyerTree);
  const result = { scenario: scenarioName, sellerTree, buyerTree, sellerTreeInfo: treeInfo(sellerTree), buyerTreeInfo: treeInfo(buyerTree), runDir, startedAt: new Date().toISOString(), violations: [], notes: [] };
  const procs = [];
  let anvil; let mock; const rpcProxies = [];
  try {
    mock = await startMockUpstream({
      minLatencyMs: sc.minLatencyMs, maxLatencyMs: sc.maxLatencyMs, minOut: sc.minOut, maxOut: sc.maxOut,
      fault500Rate: 0, disconnectRate: 0,
    });
    let topUpThresholdBps;
    ({ child: anvil, topUpThresholdBps } = await freshChain({ port: PORTS.anvil, contractsDir: CONTRACTS_DIR, stateFile: STATE_FILE, blockTime: RPC_PROFILE === 'base' ? 2 : sc.blockTime }));
    result.topUpThresholdBps = topUpThresholdBps;
    result.rpcLagWindowMs = Number(process.env.RPC_LAG_WINDOW_MS ?? 4000);
    const rpc = `http://127.0.0.1:${PORTS.anvil}`;
    let sellerRpc = rpc; let buyerRpc = rpc;
    if (RPC_PROFILE === 'base') {
      // Only the seller sends transactions; the buyer's reads must lag after them too.
      const chainClock = { lastTxAt: 0 };
      const sp = await startRpcProxy({ port: PORTS.sellerRpc, upstream: rpc, seed: 11 + SLOT, chain: chainClock });
      const bp = await startRpcProxy({ port: PORTS.buyerRpc, upstream: rpc, seed: 29 + SLOT, chain: chainClock });
      rpcProxies.push(['seller', sp], ['buyer', bp]);
      sellerRpc = sp.url; buyerRpc = bp.url;
    }
    result.rpcProfile = RPC_PROFILE;
    const chain0 = chainSnapshot(rpc);

    const boot = new Proc('bootstrap', process.execPath, [join(HERE, 'bootstrap.mjs'), join(buyerTree, 'packages/node/dist'), String(PORTS.bootstrap)], { PATH: process.env.PATH, HOME: buyerHome }, join(runDir, 'bootstrap.log'));
    boot.start(); procs.push(boot);
    await waitFor(() => readFileSync(join(runDir, 'bootstrap.log'), 'utf8').includes('BOOTSTRAP_READY'), 'bootstrap', 15000, 100);

    writeSellerConfig(sellerDir, sellerRpc, mock.port, sc);
    writeBuyerConfig(buyerDir, buyerRpc, sc);
    const sellerLog = join(runDir, 'seller.log'); const buyerLog = join(runDir, 'buyer.log');
    const seller = cliProc('seller', sellerTree, sellerDir, sellerHome,
      ['seller', 'start', '--dht-port', String(PORTS.sellerDht), '--signaling-port', String(PORTS.sellerSig), '--no-dashboard'],
      sellerLog, { ANTSEED_SETTLEMENT_IDLE_MS: '15000' });
    seller.start(); procs.push(seller);
    await waitFor(() => {
      const l = readFileSync(sellerLog, 'utf8');
      if (!seller.alive) throw new Error('seller exited during startup');
      return /Seller node started|Announced|announce|Seeding|listening/i.test(l) && seller.alive;
    }, 'seller start', 60000);
    const buyer = cliProc('buyer', buyerTree, buyerDir, buyerHome,
      ['buyer', 'start', '--port', String(PORTS.buyerProxy), '--peer', SELLER_PEER, '--no-verifier'], buyerLog);
    buyer.start(); procs.push(buyer);
    await waitFor(async () => {
      if (!buyer.alive) throw new Error('buyer exited during startup');
      const r = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/status`); return r.ok;
    }, 'buyer proxy', 60000);

    // Isolation guard: both nodes must use only the local bootstrap and never resolve a non-local peer.
    for (const f of [sellerLog, buyerLog]) {
      const l = readFileSync(f, 'utf8');
      const m = l.match(/Starting as \w+ with (\d+) bootstrap node/);
      if (!m || m[1] !== '1') throw new Error(`ISOLATION: ${f} bootstrap count ${m?.[1]}`);
    }
    // Warm up: one small request must succeed (opens the channel).
    const warm = await waitFor(async () => {
      const r = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/v1/chat/completions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'mock-model', messages: [{ role: 'user', content: `[req:warm${randomUUID().slice(0, 6)}] hi` }] }),
      });
      const t = await r.text();
      if (r.status === 200) return true;
      result.notes.push(`warmup ${r.status}: ${t.slice(0, 200)}`);
      return false;
    }, 'warmup request', 120000, 2000);
    void warm;

    // Faults switch on for the load phase only.
    mock.setFaults({ fault500Rate: sc.fault500Rate, disconnectRate: sc.disconnectRate });

    const results = [];
    let restartInfo = null;
    const restartAt = sc.restart ? Math.floor(sc.requests * sc.restart.atFraction) : -1;
    let restarting = null;
    const t0 = Date.now();
    await runLoad(sc, results, (done) => {
      if (done === restartAt && !restarting) {
        restarting = (async () => {
          const p = sc.restart.who === 'buyer' ? buyer : seller;
          const ts = Date.now();
          const stopInfo = await p.stop();
          p.start();
          if (sc.restart.who === 'buyer') {
            await waitFor(async () => (await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/status`)).ok, 'buyer restart', 60000, 200).catch(() => {});
          } else {
            // Wait until the seller's signaling port accepts connections again.
            const net = await import('node:net');
            await waitFor(() => new Promise((r) => { const c = net.connect(PORTS.sellerSig, '127.0.0.1'); c.on('connect', () => { c.destroy(); r(true); }); c.on('error', () => r(false)); }), 'seller restart', 60000, 250).catch(() => {});
            await sleep(2000);
          }
          restartInfo = { who: sc.restart.who, stoppedAt: ts - t0, downMs: Date.now() - ts, ...stopInfo };
        })();
        LOAD_STATE.restarting = restarting.finally(() => { LOAD_STATE.restarting = null; });
      }
    });
    if (restarting) await restarting;
    if (sc.stale1050) {
      result.issue1050 = await stale1050Phase({ sc, seller, buyer, buyerDir, buyerTree, buyerHome, rpc, result });
      // Pay again: the buyer must open a fresh channel and settle it like any other.
      await runLoad({ ...sc, requests: sc.requests }, results);
    }
    result.loadMs = Date.now() - t0;
    result.restart = restartInfo;
    mock.setFaults({ fault500Rate: 0, disconnectRate: 0 });

    {
      const l = readFileSync(buyerLog, 'utf8');
      const ext = [...l.matchAll(/https?:\/\/(\d+\.\d+\.\d+\.\d+)/g)].map((x) => x[1]).filter((ip) => !ip.startsWith('127.'));
      if (ext.length) { result.violations.push({ kind: 'HARNESS-ISOLATION-LEAK', ips: [...new Set(ext)].slice(0, 5) }); }
    }
    // Quiesce: let post-response NeedAuth / SpendingAuth round trips finish.
    await sleep(10000);
    result.procAliveBeforeClose = { seller: seller.alive, buyer: buyer.alive };
    const sellerDb = join(sellerDir, 'payments', 'sessions.db');
    const buyerDb = join(buyerDir, 'payments', 'sessions.db');
    const q = "select session_id, peer_id, role, auth_max, tokens_delivered, status, settled_amount, previous_consumption, request_count from payment_channels";
    const sellerRowsPre = sqliteJson(sellerDb, q).filter((r) => r.role === 'seller');
    const buyerRowsPre = sqliteJson(buyerDb, q).filter((r) => r.role === 'buyer');

    // Buyer view of usage.
    try { result.buyerUsage = await (await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/buyer-usage`)).json(); } catch (e) { result.notes.push(`buyer-usage: ${e.message}`); }
    let channelsView = [];
    try { channelsView = (await (await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/channels`)).json()).channels ?? []; } catch {}

    // Cooperative close of every active channel, then read the chain.
    const closeResults = [];
    for (const ch of channelsView) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORTS.buyerProxy}/_antseed/channels/close`, {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ peerId: ch.peerId, channelId: ch.channelId }),
        });
        closeResults.push({ channelId: ch.channelId, http: r.status, body: (await r.text()).slice(0, 300) });
      } catch (e) { closeResults.push({ channelId: ch.channelId, error: e.message }); }
    }
    result.closeResults = closeResults;
    const allIds = [...new Set([...sellerRowsPre.map((r) => r.session_id), ...buyerRowsPre.map((r) => r.session_id)])];
    const onchain = {};
    await waitFor(() => {
      let allClosed = true;
      for (const id of allIds) {
        onchain[id] = readChannel(rpc, id);
        if (onchain[id].status === 1) allClosed = false;
      }
      return allClosed;
    }, 'on-chain close', 60000, 1000).catch((e) => result.notes.push(`close wait: ${e.message}`));
    for (const id of allIds) onchain[id] = readChannel(rpc, id);
    await sleep(1500);
    const sellerRowsPost = sqliteJson(sellerDb, q).filter((r) => r.role === 'seller');
    const buyerRowsPost = sqliteJson(buyerDb, q).filter((r) => r.role === 'buyer');
    const chain1 = chainSnapshot(rpc);

    // ── Invariants ──
    const big = (v) => BigInt(v ?? '0');
    const sumSpent = sellerRowsPost.reduce((a, r) => a + big(r.tokens_delivered), 0n);
    const sumAccepted = sellerRowsPost.reduce((a, r) => a + big(r.auth_max), 0n);
    const sumSigned = buyerRowsPost.reduce((a, r) => a + big(r.auth_max), 0n);
    const sumSettled = Object.values(onchain).reduce((a, c) => a + c.settled, 0n);
    const buyerDecrease = chain0.buyerBalance - chain1.buyerBalance;
    const sellerGain = chain1.sellerUsdc - chain0.sellerUsdc;
    const feeGain = chain1.reserveUsdc - chain0.reserveUsdc;
    const channels = allIds.map((id) => {
      const s = sellerRowsPost.find((r) => r.session_id === id); const sPre = sellerRowsPre.find((r) => r.session_id === id);
      const b = buyerRowsPost.find((r) => r.session_id === id);
      return {
        id, sellerSpent: s?.tokens_delivered ?? null, sellerAcceptedPreClose: sPre?.auth_max ?? null, sellerAccepted: s?.auth_max ?? null,
        buyerSigned: b?.auth_max ?? null, onchainSettled: onchain[id].settled.toString(), onchainDeposit: onchain[id].deposit.toString(),
        onchainStatus: onchain[id].status, sellerStatus: s?.status ?? null, buyerStatus: b?.status ?? null,
        sellerRequests: s?.request_count ?? null,
      };
    });
    for (const ch of channels) {
      const spent = big(ch.sellerSpent); const acc = big(ch.sellerAcceptedPreClose); const settled = big(ch.onchainSettled);
      if (ch.sellerSpent != null && spent > acc) result.violations.push({ kind: 'served-unpaid(spent>accepted at drain)', channel: ch.id, spent: spent.toString(), accepted: acc.toString(), gap: (spent - acc).toString() });
      if (ch.sellerSpent != null && spent > settled) result.violations.push({ kind: 'served-unsettled(spent>onchain settled)', channel: ch.id, spent: spent.toString(), settled: settled.toString(), gap: (spent - settled).toString() });
      if (ch.buyerSigned != null && big(ch.buyerSigned) !== settled) result.violations.push({ kind: 'buyer-signed!=settled', channel: ch.id, signed: ch.buyerSigned, settled: settled.toString() });
      if (ch.sellerAccepted != null && big(ch.sellerAccepted) !== settled) result.violations.push({ kind: 'seller-accepted!=settled', channel: ch.id, accepted: ch.sellerAccepted, settled: settled.toString() });
      if (ch.onchainStatus === 1) result.violations.push({ kind: 'channel-still-active-after-close', channel: ch.id });
      if (big(ch.sellerAccepted ?? '0') > spent + 0n && ch.sellerSpent != null) result.notes.push(`channel ${ch.id.slice(0, 10)} accepted ${ch.sellerAccepted} > spent ${spent} (buyer paid ${big(ch.sellerAccepted) - spent} beyond seller-recorded spend)`);
    }
    if (buyerDecrease !== sumSettled) result.violations.push({ kind: 'buyer-deposit-decrease!=sum-settled', buyerDecrease: buyerDecrease.toString(), sumSettled: sumSettled.toString() });
    if (sellerGain + feeGain !== buyerDecrease) result.violations.push({ kind: 'seller+fee!=buyer-decrease', sellerGain: sellerGain.toString(), feeGain: feeGain.toString(), buyerDecrease: buyerDecrease.toString() });
    if (chain1.buyerReserved !== 0n) result.violations.push({ kind: 'buyer-reserved-left', reserved: chain1.buyerReserved.toString() });
    // Delivered-cost comparison (mock is ground truth for fully delivered responses).
    const expected = mock.stats.expectedCostBaseUnits;
    const overpay = sumSettled - expected;
    result.money = {
      mockExpectedDelivered: expected.toString(), sellerSpent: sumSpent.toString(), sellerAccepted: sumAccepted.toString(), buyerSigned: sumSigned.toString(),
      onchainSettled: sumSettled.toString(), buyerDecrease: buyerDecrease.toString(), sellerGain: sellerGain.toString(), feeGain: feeGain.toString(),
      settledMinusExpected: overpay.toString(), spentMinusExpected: (sumSpent - expected).toString(),
    };
    // Mock records: all fully-delivered ok responses were billed? Allow rounding.
    const faultFree = sc.fault500Rate === 0 && sc.disconnectRate === 0 && sc.abortRatio === 0 && !sc.restart;
    if (faultFree && sumSpent !== expected) result.violations.push({ kind: 'seller-spent!=delivered-cost(fault-free)', spent: sumSpent.toString(), expected: expected.toString() });
    if (sumSettled > sumSpent) result.violations.push({ kind: 'buyer-overpaid(settled>seller-spent)', settled: sumSettled.toString(), spent: sumSpent.toString() });

    result.channels = channels;
    result.chain0 = Object.fromEntries(Object.entries(chain0).map(([k, v]) => [k, v.toString()]));
    result.chain1 = Object.fromEntries(Object.entries(chain1).map(([k, v]) => [k, v.toString()]));

    // Client results.
    const ok = results.filter((r) => !r.error && !r.clientAborted);
    const failures = {};
    for (const r of results) if (r.error) failures[r.error] = (failures[r.error] ?? 0) + 1;
    result.client = {
      total: results.length, ok: ok.length, clientAborted: results.filter((r) => r.clientAborted).length,
      failed: results.filter((r) => r.error).length, failures,
      p50: pct(ok.map((r) => r.ms), 50), p95: pct(ok.map((r) => r.ms), 95), max: pct(ok.map((r) => r.ms), 100),
    };
    if (sc.restart && restartInfo) {
      // Failures during the restart window are expected; separate them.
      const winStart = restartInfo.stoppedAt; const winEnd = restartInfo.stoppedAt + restartInfo.downMs + 15000;
      const inWin = results.filter((r) => r.error && (r.start - t0) <= winEnd && (r.start - t0 + r.ms) >= winStart);
      result.client.failedInRestartWindow = inWin.length;
      result.client.failedOutsideRestartWindow = results.filter((r) => r.error).length - inWin.length;
    }
    result.mock = { images: mock.stats.images ?? 0, imageRequests: mock.stats.imageRequests ?? 0, expectedImageUnitCost: String(mock.stats.expectedImageUnitCost ?? 0n), requests: mock.stats.requests, completed: mock.stats.completed, faults500: mock.stats.faults500, disconnects: mock.stats.disconnects, clientGone: mock.stats.clientGone, maxActive: mock.stats.maxActive };
    writeFileSync(join(runDir, 'requests.json'), JSON.stringify(results, null, 1));
    // Unexpected exits.
    result.unexpectedExits = procs.flatMap((p) => p.exits.filter((e) => !e.expected).map((e) => ({ proc: p.name, ...e })));
    if (result.unexpectedExits.length) result.violations.push({ kind: 'process-exited-unexpectedly', detail: result.unexpectedExits });
  } catch (err) {
    result.harnessError = err.stack ?? String(err);
  } finally {
    const stops = [];
    for (const p of procs.reverse()) stops.push({ name: p.name, ...(await p.stop(15000)) });
    result.shutdown = stops;
    const stuck = stops.filter((s) => s.forced && s.name !== 'bootstrap');
    if (stuck.length) result.violations.push({ kind: 'process-needed-SIGKILL-on-shutdown', detail: stuck });
    result.rpcStats = Object.fromEntries(rpcProxies.map(([who, p]) => [who, p.stats]));
    for (const [, p] of rpcProxies) await p.close();
    if (anvil) anvil.kill('SIGKILL');
    if (mock) await mock.close();
    await sleep(500);
  }
  result.sellerLog = scanLog(join(runDir, 'seller.log'), SELLER_PATTERNS);
  // Seller's own per-request delivered costs ("Cost recorded: ... cost=N").
  try {
    let costSum = 0n; let costN = 0; let unitSum = 0n;
    for (const line of readFileSync(join(runDir, 'seller.log'), 'utf8').split('\n')) {
      const m = line.match(/Cost recorded: .*?cost=(\d+)/);
      if (m) { costSum += BigInt(m[1]); costN++; }
      const u = line.match(/unit(?:Cost| cost)=(\d+)/i);
      if (u) unitSum += BigInt(u[1]);
    }
    if (result.money) {
      result.money.sellerCostRecordedSum = costSum.toString();
      result.money.sellerCostRecordedCount = costN;
      const settled = BigInt(result.money.onchainSettled);
      result.money.deliveredUnpaid = (costSum > settled ? costSum - settled : 0n).toString();
      result.money.paidBeyondDelivered = (settled > costSum ? settled - costSum : 0n).toString();
      if (settled > costSum) result.violations.push({ kind: 'buyer-paid-more-than-seller-recorded-delivered(double-pay?)', settled: settled.toString(), recorded: costSum.toString() });
      if (costSum > settled) result.violations.push({ kind: 'delivered-but-unpaid(cost-recorded>settled)', recorded: costSum.toString(), settled: settled.toString(), gap: (costSum - settled).toString() });
    }
  } catch {}
  result.buyerLog = scanLog(join(runDir, 'buyer.log'), BUYER_PATTERNS);
  for (const k of ['crash']) {
    if (result.sellerLog.counts[k]) result.violations.push({ kind: `seller-log-${k}`, ex: result.sellerLog.ex[k] });
    if (result.buyerLog.counts[k]) result.violations.push({ kind: `buyer-log-${k}`, ex: result.buyerLog.ex[k] });
  }
  result.finishedAt = new Date().toISOString();
  writeFileSync(join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
  const tree = arg('tree', REPO);
  const sellerTree = resolve(arg('seller-tree', tree));
  const buyerTree = resolve(arg('buyer-tree', tree));
  const scenarioName = arg('scenario', 'smoke');
  const runs = Number(arg('runs', '1'));
  const label = arg('label', `${scenarioName}`);
  const sc = { ...SCENARIOS[scenarioName] };
  if (!SCENARIOS[scenarioName]) throw new Error(`unknown scenario ${scenarioName}; have ${Object.keys(SCENARIOS).join(', ')}`);
  for (const k of ['concurrency', 'requests']) if (arg(k)) sc[k] = Number(arg(k));
  const outDir = join(OUT, 'results', label);
  mkdirSync(outDir, { recursive: true });
  const summaryFile = join(outDir, 'summary.jsonl');
  for (let r = 1; r <= runs; r++) {
    const runDir = join(OUT, 'runs', `${label}-${r}`);
    const t = Date.now();
    const res = await oneRun({ scenarioName, sc, sellerTree, buyerTree, runDir });
    const line = { label, run: r, scenario: scenarioName, sellerTree, buyerTree, sellerTreeInfo: res.sellerTreeInfo, buyerTreeInfo: res.buyerTreeInfo, runDir, ms: Date.now() - t,
      harnessError: res.harnessError?.split('\n')[0], client: res.client, violations: res.violations, money: res.money,
      sellerLog: res.sellerLog.counts, buyerLog: res.buyerLog.counts, restart: res.restart, issue1050: res.issue1050, channels: res.channels?.length, notes: res.notes, mock: res.mock };
    appendFileSync(summaryFile, JSON.stringify(line) + '\n');
    console.log(`[${label} ${r}/${runs}] ${res.harnessError ? 'HARNESS-ERROR ' + res.harnessError.split('\n')[0] : ''} ok=${res.client?.ok}/${res.client?.total} fail=${JSON.stringify(res.client?.failures)} viol=${res.violations.map((v) => v.kind).join(',') || 'none'} p50=${res.client?.p50} p95=${res.client?.p95} sellerRej=${res.sellerLog.counts.rejectUnderfunded} behind=${res.sellerLog.counts.behindSpendAccepted} settled=${res.money?.onchainSettled} expected=${res.money?.mockExpectedDelivered} (${Math.round((Date.now() - t) / 1000)}s)${res.issue1050 ? ' 1050=' + JSON.stringify(res.issue1050) : ''}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });

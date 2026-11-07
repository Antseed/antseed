#!/usr/bin/env node
// Long-lived testbench owner: Anvil (Base fork or local chain), private bootstrap, mocks, seller workers, buyer + proxy, control API.
// Started detached by `pnpm testbench up`; stopped by `pnpm testbench down` (POST /shutdown) or SIGTERM.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindUpstream, listModels, WORKSPACE_PLUGINS } from './lib/config.mjs';
import { blocksInUse, copyIn, pruneCache, resolveForkBlock, seedFromLegacy, writeBack } from './lib/cache.mjs';
import { chainReader, prepareChain, prepareLocalChain } from './lib/chain.mjs';
import { chainContracts, deployLocalStack, localGenesisTimestamp } from './lib/local-deploy.mjs';
import { newToken, startControlServer } from './lib/control.mjs';
import { startRpcRelay } from './lib/rpc-relay.mjs';
import { DEFAULT_IDLE_MINUTES, watchdogDecision, WATCHDOG_INTERVAL_MS } from './lib/watchdog.mjs';
import { assertSellerPaymentsOn, assertSingleBootstrap, buyerProxyListening, cliArgs, cliBuyerClient, cliNodeEnv, CLI_STOP_GRACE_MS, linkPlugins, sellerReady, spawnCliNode, stopWithGrace, waitForCliReady } from './lib/cli-node.mjs';
import { anvilExitMessage, assertLocalUrl, isAddressInUse, isolatedEnv, listenWithRetry, redactingStream } from './lib/env.mjs';
import { acquireLock, isOwnedProcessAlive, ownProcessEntry, processStartTime, releaseLock } from './lib/lock.mjs';
import { readJson, saveJson, validateManifest, MANIFEST_VERSION, TESTBENCH_CHAIN_IDS } from './lib/manifest.mjs';
import { startMock } from './lib/mock.mjs';
import { assertCliConfig, cliBuyerConfig, cliSellerConfig, paymentsConfig, testbenchNodeOptions } from './lib/node-options.mjs';
import { resetRunState, testbenchPaths } from './lib/paths.mjs';
import { logOffsets, peerLogs } from './lib/stress.mjs';
import { createPrng, derive } from './lib/prng.mjs';
import { buyerRoutingPreferences } from './lib/topology.mjs';
import { startRpcProxy } from '../stress/rpc-proxy.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const [root, name] = process.argv.slice(2);
const paths = testbenchPaths(root, name);
const plan = JSON.parse(await readFile(join(paths.config, 'plan.json'), 'utf8'));
// Secrets never go into plan.json: the fork RPC URL and live API keys arrive via env and are read before it is cleaned.
const forkUrl = process.env.ANTSEED_TESTBENCH_FORK_URL;
// forge needs the real HOME for its solc cache (~/.svm, ~/.foundry); every AntSeed process keeps the private one.
const toolHome = process.env.ANTSEED_TESTBENCH_TOOL_HOME;
const target = plan.target ?? 'fork';
const local = target === 'local';
const cliMode = plan.mode === 'cli';
const liveEnv = Object.fromEntries((plan.liveKeys ?? []).map((key) => [key, process.env[key]]));
const log = (message) => console.log(`[supervisor] ${new Date().toISOString()} ${message}`);
const waitFor = async (check, label, timeoutMs = 60_000, intervalMs = 200) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}`);
};

const state = {
  anvil: null, rpcRelay: null, bootstrap: null, mocks: new Map(), workers: new Map(), buyer: null, proxy: null, control: null, reader: null,
  needAuthLoss: { remaining: 0, lost: [] },
  // Chain links per node ('buyer', 'seller:<id>') when the topology asks for Base-like RPCs.
  rpcLinks: new Map(),
  // What the payment stress harness fails a run on besides money: crashes, unexpected exits, stops that needed SIGKILL.
  health: { unexpectedExits: [], forcedStops: [], unhandledRejections: [] },
};
let manifest = null;
let lockEntry = null;
let shuttingDown = null;
// The `run` or `up` driving this testbench, its last heartbeat, and the last two control requests (the previous one
// is what `status` reports: its own request is always the latest).
const watch = { starter: plan.starter ?? null, idleMinutes: plan.idleMinutes ?? DEFAULT_IDLE_MINUTES, heartbeatAt: Date.now(), lastRequestAt: Date.now(), previousRequestAt: Date.now() };
let reaper = null;

async function writeManifest(patch) {
  manifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
  await saveJson(paths.manifest, manifest);
}

/** Starts lib/reaper.mjs; `reap(child)` hands it a child to stop if this process dies by SIGKILL. */
function startReaper() {
  reaper = spawn(process.execPath, [join(here, 'lib/reaper.mjs')], { stdio: ['pipe', 'inherit', 'inherit'] });
  reaper.stdin.on('error', () => {});
  reaper.stdin.unref();
  reaper.unref();
}

function reap(child) {
  reaper?.stdin.write(`${JSON.stringify({ pid: child.pid, startedAt: processStartTime(child.pid) })}\n`);
}

/**
 * Anvil on a free loopback port: a Base fork at `block` when forkUrl is set, otherwise an empty chain 31337 (whose
 * genesis is `timestamp` when given, see localGenesisTimestamp).
 */
async function startAnvil(forkUrl, block, { timestamp } = {}) {
  const logStream = createWriteStream(join(paths.logs, 'anvil.log'), { flags: 'a' });
  const expectedChainId = `0x${(forkUrl ? TESTBENCH_CHAIN_IDS.fork : TESTBENCH_CHAIN_IDS.local).toString(16)}`;
  const { port, value: child } = await listenWithRetry(async (candidate) => {
    const args = [
      ...(forkUrl
        ? ['--fork-url', forkUrl, '--fork-block-number', String(block), '--chain-id', String(TESTBENCH_CHAIN_IDS.fork), '--no-rate-limit', '--retries', '20', '--timeout', '120000']
        : ['--chain-id', String(TESTBENCH_CHAIN_IDS.local), ...(timestamp ? ['--timestamp', String(timestamp)] : [])]),
      '--host', '127.0.0.1', '--port', String(candidate),
      '--disable-min-priority-fee', '--base-fee', '0', '--gas-price', '0',
    ];
    const spawned = spawn('anvil', args, { env: isolatedEnv(process.env, paths.anvilHome), stdio: ['ignore', 'pipe', 'pipe'] });
    reap(spawned);
    spawned.stdout.pipe(redactingStream(forkUrl)).pipe(logStream, { end: false });
    spawned.stderr.pipe(redactingStream(forkUrl)).pipe(logStream, { end: false });
    // Kept only to classify an early exit; never printed (it can contain the fork URL).
    let output = '';
    const keep = (chunk) => { output = (output + chunk.toString('utf8')).slice(-8192); };
    spawned.stdout.on('data', keep);
    spawned.stderr.on('data', keep);
    const rpcUrl = `http://127.0.0.1:${candidate}`;
    try {
      await waitFor(async () => {
        if (spawned.exitCode !== null) {
          const error = new Error(anvilExitMessage(spawned.exitCode, output, { fork: Boolean(forkUrl), logPath: join(paths.logs, 'anvil.log') }));
          if (isAddressInUse(output)) error.code = 'EADDRINUSE';
          throw error;
        }
        try {
          const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(2000) });
          return (await response.json()).result === expectedChainId;
        } catch {
          return false;
        }
      }, 'Anvil RPC', 60_000);
    } catch (error) {
      spawned.kill('SIGKILL');
      throw error;
    }
    return spawned;
  });
  return { child, port, rpcUrl: `http://127.0.0.1:${port}` };
}

/**
 * Per-model prices for a seller's mock, so its delivery ledger costs each response the way the seller bills it:
 * provider defaults merged with the service's pricing, plus the per-image price of an openai-images unit model.
 * Keyed by service id and upstream model (whichever name reaches the mock).
 */
function mockPricing(providers) {
  const pricing = {};
  for (const provider of Object.values(providers)) {
    for (const [serviceId, service] of Object.entries(provider.services ?? {})) {
      const price = { ...(provider.defaults ?? {}), ...(service.pricing ?? {}) };
      const image = service.unitBillingModels?.['openai-images']?.components?.find((component) => component.unit === 'output_images');
      if (image) price.imageUsd = image.priceUsd;
      pricing[serviceId] = price;
      if (service.upstreamModel) pricing[service.upstreamModel] = price;
    }
  }
  return pricing;
}

function spawnSeller(seller, env) {
  const logStream = createWriteStream(join(paths.logs, `seller-${seller.id}.log`), { flags: 'a' });
  const child = fork(join(here, 'seller-worker.mjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  reap(child);
  child.stdout.pipe(logStream);
  child.stderr.pipe(logStream);
  return child;
}

async function startSellerWorker(seller) {
  const env = isolatedEnv(process.env, paths.home, { ...seller.env, ...(plan.verbose ? { ANTSEED_DEBUG: '1' } : {}) });
  const child = spawnSeller(seller, env);
  const ready = new Promise((resolveReady, rejectReady) => {
    const onMessage = (message) => {
      if (message.type === 'ready') { child.off('message', onMessage); resolveReady(message); }
      if (message.type === 'error') { child.off('message', onMessage); rejectReady(new Error(`seller ${seller.id}: ${message.message}`)); }
    };
    child.on('message', onMessage);
    child.once('exit', (code) => rejectReady(new Error(`seller ${seller.id} exited with ${code} (see logs/seller-${seller.id}.log)`)));
  });
  child.send({ type: 'start', id: seller.id, dataDir: seller.dataDir, configPath: seller.configPath, bootstrapNodes: seller.bootstrapNodes, payments: seller.payments });
  const info = await Promise.race([ready, new Promise((_, rejectTimeout) => setTimeout(() => rejectTimeout(new Error(`seller ${seller.id} start timeout`)), 120_000))]);
  return trackSeller(seller.id, child, info);
}

function trackSeller(id, child, info) {
  const entry = { child, info, process: { pid: child.pid, startedAt: processStartTime(child.pid) }, stopping: false };
  child.on('exit', (code, signal) => {
    log(`Seller ${cliMode ? 'process' : 'worker'} ${id} (${child.pid}) exited (${code ?? signal})`);
    if (!entry.stopping && !shuttingDown) state.health.unexpectedExits.push({ who: `seller:${id}`, code, signal, at: new Date().toISOString() });
    if (state.workers.get(id) === entry) state.workers.delete(id);
  });
  state.workers.set(id, entry);
  return entry;
}

/** Records a CLI process as soon as it exists, so `down --force` finds it even if the supervisor dies during startup. */
async function recordNodeProcess(who, child) {
  await writeManifest({ nodeProcesses: { ...manifest.nodeProcesses, [who]: { pid: child.pid, startedAt: processStartTime(child.pid) } } });
}

/**
 * Spawns a CLI process and waits until `ready` says it is up; one that fails to come up is killed, not left behind.
 * Refuses a node that sees more than the private bootstrap node.
 */
async function launchCliNode(spec, ready) {
  const node = spawnCliNode(spec);
  reap(node.child);
  await recordNodeProcess(spec.who, node.child);
  try {
    const value = await waitForCliReady(node, () => ready(node));
    assertSingleBootstrap(node.output(), spec.who);
    node.stopCapture();
    return { node, value };
  } catch (error) {
    node.child.kill('SIGKILL');
    throw error;
  }
}

/** cli mode: `antseed seller start` on the seller's data dir. A restarted seller keeps its ports, like a real one. */
async function startSellerProcess(seller) {
  const ports = seller.ports ? ['--dht-port', String(seller.ports.dhtPort), '--signaling-port', String(seller.ports.signalingPort)] : [];
  const statePath = join(seller.dataDir, 'daemon.state.json');
  const { node, value: daemon } = await launchCliNode({
    who: `seller:${seller.id}`,
    args: cliArgs(repo, seller.dataDir, ['seller', 'start', '--no-dashboard', ...ports]),
    env: cliNodeEnv(process.env, paths.home, seller.env),
    logPath: join(paths.logs, `seller-${seller.id}.log`),
  }, async (candidate) => sellerReady(candidate.output(), await readJson(statePath).catch(() => null), candidate.child.pid));
  assertSellerPaymentsOn(node.output(), `seller:${seller.id}`);
  seller.ports = { dhtPort: daemon.dhtPort, signalingPort: daemon.signalingPort };
  log(`Seller process ${seller.id} (${node.child.pid}) peer=${daemon.peerId} dht=${daemon.dhtPort} signaling=${daemon.signalingPort}`);
  return trackSeller(seller.id, node.child, { peerId: daemon.peerId, dhtPort: daemon.dhtPort, signalingPort: daemon.signalingPort });
}

const startSeller = (seller) => (cliMode ? startSellerProcess(seller) : startSellerWorker(seller));

async function stopSellerWorker(id) {
  const worker = state.workers.get(id);
  if (!worker) return false;
  state.workers.delete(id);
  worker.stopping = true;
  const graceMs = cliMode ? CLI_STOP_GRACE_MS : 15_000;
  await stopWithGrace(worker.child, {
    graceMs,
    // Only a forked worker has an IPC channel; a CLI process stops on SIGTERM.
    requestStop: () => (cliMode ? worker.child.kill('SIGTERM') : worker.child.send({ type: 'stop' })),
    onForced: (afterMs) => {
      state.health.forcedStops.push({ who: `seller:${id}`, afterMs, at: new Date().toISOString() });
      log(`Seller ${id} did not stop within ${graceMs / 1000}s; SIGKILL`);
    },
  });
  return true;
}

let buyerRuntime = null;

/**
 * Fault hook behind POST /faults/buyer/need-auth-loss: the buyer drops the next N NeedAuth frames from
 * sellers, as if they were lost on the wire. The node has no public seam for losing a payment frame,
 * so this wraps the buyer payment manager's public handleNeedAuth, which the negotiator calls per frame.
 * Every buyer start disarms the fault and forgets earlier losses.
 */
function injectNeedAuthLoss(bpm) {
  state.needAuthLoss = { remaining: 0, lost: [] };
  if (!bpm) {
    log('Fault hook not installed: the buyer has no payment manager');
    return;
  }
  const handleNeedAuth = bpm.handleNeedAuth.bind(bpm);
  bpm.handleNeedAuth = async (sellerPeerId, payload, paymentMux) => {
    if (state.needAuthLoss.remaining === 0) return handleNeedAuth(sellerPeerId, payload, paymentMux);
    state.needAuthLoss.remaining -= 1;
    state.needAuthLoss.lost.push({ sellerPeerId, ...payload, lostAt: new Date().toISOString() });
    log(`Fault: lost NeedAuth required=${payload.requiredCumulativeAmount} lastRequestCost=${payload.lastRequestCost ?? 'none'}`);
  };
}

/** cli mode: `antseed buyer start` (on `port`, or a free one the first time). state.buyer gets the node's API over the proxy. */
async function startBuyerProcess(port) {
  const { peerId, bootstrapNodes, payments, chain, routingPreferences } = buyerRuntime;
  const launch = async (candidatePort) => {
    await saveJson(manifest.buyerConfig, assertCliConfig(cliBuyerConfig({ proxyPort: candidatePort, routingPreferences, maxPricing: plan.topology.buyer.maxPricing, chain, bootstrapNodes, payments }), 'buyer'));
    const url = `http://127.0.0.1:${candidatePort}`;
    const { node } = await launchCliNode({
      who: 'buyer',
      args: cliArgs(repo, paths.buyer, ['buyer', 'start', '--port', String(candidatePort), '--no-verifier']),
      env: cliNodeEnv(process.env, paths.home, plan.topology.buyer.env),
      logPath: join(paths.logs, 'buyer.log'),
    }, async (candidate) => {
      if (!buyerProxyListening(candidate.output(), candidatePort)) return false;
      return (await fetch(`${url}/_antseed/status`, { signal: AbortSignal.timeout(2000) }).then((response) => response.json()).catch(() => null))?.ok === true;
    });
    const entry = { ...cliBuyerClient(url), peerId, stopping: false };
    entry.stop = async () => {
      entry.stopping = true;
      await stopWithGrace(node.child, {
        onForced: (afterMs) => {
          state.health.forcedStops.push({ who: 'buyer', afterMs, at: new Date().toISOString() });
          log(`Buyer did not stop within ${CLI_STOP_GRACE_MS / 1000}s; SIGKILL`);
        },
      });
    };
    node.child.on('exit', (code, signal) => {
      log(`Buyer process (${node.child.pid}) exited (${code ?? signal})`);
      if (!entry.stopping && !shuttingDown) state.health.unexpectedExits.push({ who: 'buyer', code, signal, at: new Date().toISOString() });
      if (state.buyer === entry) state.buyer = null;
    });
    return entry;
  };
  if (port) {
    state.buyer = await launch(port);
    return port;
  }
  const started = await listenWithRetry(launch);
  state.buyer = started.value;
  return started.port;
}

/** Starts the buyer node and its BuyerProxy (on `port`, or a free one the first time). */
async function startBuyerInProcess(port) {
  const { sdk, BuyerProxy, bootstrapNodes, payments, chain, routingPreferences } = buyerRuntime;
  const buyerChain = { ...chain, rpcUrl: payments.rpcUrl };
  state.buyer = new sdk.AntseedNode(testbenchNodeOptions({ role: 'buyer', dataDir: paths.buyer, bootstrapNodes, payments }));
  await state.buyer.start();
  injectNeedAuthLoss(state.buyer.buyerPaymentManager);
  const launch = async (candidatePort) => {
    await saveJson(manifest.buyerConfig, {
      buyer: { proxyPort: candidatePort, minPeerReputation: 0, routingPreferences, ...(plan.topology.buyer.maxPricing ? { maxPricing: plan.topology.buyer.maxPricing } : {}) },
      payments: { crypto: { ...buyerChain, networkStatsUrl: '', explorerApiUrl: '' } },
      network: { bootstrapNodes: bootstrapNodes.map((n) => `${n.host}:${n.port}`) },
      relayer: { enabled: false },
    });
    const { loadConfig } = await import(join(repo, 'apps/cli/dist/config/loader.js'));
    const loaded = await loadConfig(manifest.buyerConfig);
    const candidate = new BuyerProxy({ node: state.buyer, port: candidatePort, dataDir: paths.buyer, configPath: manifest.buyerConfig, routingPreferences: loaded.buyer.routingPreferences, backgroundRefreshIntervalMs: 60_000 });
    await candidate.start();
    return candidate;
  };
  if (port) {
    state.proxy = await launch(port);
    return port;
  }
  const started = await listenWithRetry(launch);
  state.proxy = started.value;
  return started.port;
}

const startBuyer = (port) => (cliMode ? startBuyerProcess(port) : startBuyerInProcess(port));

/** Stops the buyer proxy and node; sellers see the peer disconnect (settle-on-disconnect). */
async function stopBuyer() {
  if (!state.buyer) return false;
  await state.proxy?.stop();
  await state.buyer.stop();
  state.proxy = null;
  state.buyer = null;
  return true;
}

async function discover(sellerIds) {
  if (!state.buyer) return;
  await waitFor(async () => {
    // A worker announces on request; a CLI seller has no such channel and announces on its own when it starts.
    if (!cliMode) for (const id of sellerIds) state.workers.get(id)?.child.send({ type: 'announce' });
    const peers = await state.buyer.discoverPeers();
    return sellerIds.every((id) => peers.some((peer) => peer.peerId === state.workers.get(id)?.info.peerId));
  }, 'buyer discovering testbench sellers', 90_000, 1000);
  const response = await fetch(`${manifest.proxyUrl}/_antseed/peers/refresh`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
  assert(response.ok, 'proxy peer refresh failed');
}

async function closeChannels(sellerIds) {
  const results = {};
  for (const id of sellerIds) {
    const seller = manifest.sellers.find((entry) => entry.id === id);
    if (!seller) throw Object.assign(new Error(`Unknown seller ${id}`), { statusCode: 404 });
    if (!state.buyer) { results[id] = 'buyer-offline'; continue; }
    const active = (await state.buyer.getActiveBuyerChannels()).filter((channel) => channel.peerId === seller.peerId);
    if (active.length === 0) { results[id] = 'no-channel'; continue; }
    if (!state.workers.has(id)) { results[id] = 'seller-offline'; continue; }
    await waitFor(async () => {
      const closed = await state.buyer.requestChannelClose(seller.peerId, { timeoutMs: 60_000 });
      if (closed.status === 'closed') return true;
      if (!['busy', 'no_channel'].includes(closed.code)) throw new Error(`close ${id}: ${JSON.stringify(closed)}`);
      return closed.code === 'no_channel';
    }, `channel close for ${id}`, 180_000, 2000);
    results[id] = 'closed';
  }
  await waitFor(async () => (await state.reader.buyerBalance(manifest.buyer.address)).reserved === 0n || Object.values(results).some((result) => result.endsWith('-offline')), 'reserves released', 120_000, 500);
  const balance = await state.reader.buyerBalance(manifest.buyer.address);
  return { results, buyer: { availableMicroUsdc: String(balance.available), reservedMicroUsdc: String(balance.reserved) } };
}

async function liveStatus() {
  const balance = await state.reader.buyerBalance(manifest.buyer.address);
  const sellers = [];
  for (const seller of manifest.sellers) {
    sellers.push({ id: seller.id, peerId: seller.peerId, address: seller.address, online: state.workers.has(seller.id), usdcMicro: String(await state.reader.usdcBalance(seller.address)), mockLatencyMs: state.mocks.get(seller.id)?.state.latencyMs ?? null });
  }
  let peers = [];
  try {
    const response = await fetch(`${manifest.proxyUrl}/_antseed/peers`, { signal: AbortSignal.timeout(5000) });
    peers = (await response.json()).peers.map((peer) => peer.peerId);
  } catch { /* proxy busy */ }
  return {
    manifest,
    live: {
      buyer: { address: manifest.buyer.address, availableMicroUsdc: String(balance.available), reservedMicroUsdc: String(balance.reserved), usdcMicro: String(await state.reader.usdcBalance(manifest.buyer.address)) },
      sellers,
      peersSeenByBuyer: peers,
      buyerOnline: Boolean(state.buyer),
      channels: await Promise.resolve(state.buyer?.getActiveBuyerChannels() ?? []).catch(() => []),
      chainBlock: await state.reader.provider.getBlockNumber(),
      health: state.health,
      rpc: rpcStats(),
      watchdog: watchdogStatus(),
    },
  };
}

/** Per-link counters of the Base-like RPC proxies (calls, 429s, stale reads, missed receipts); empty for direct links. */
function rpcStats() {
  return Object.fromEntries([...state.rpcLinks].map(([who, link]) => [who, { ...link.stats }]));
}

/**
 * The chain URL a node uses: Anvil itself, or under `chain.rpc: 'base'` its own proxy that behaves like a public
 * Base RPC (e2e/stress/rpc-proxy.mjs). All links share one chain clock, so a transaction through the seller's
 * link makes the buyer's reads lag too, as on a load-balanced public endpoint.
 */
const chainClock = { lastTxAt: 0 };
async function chainLink(who) {
  if (plan.topology.chain?.rpc !== 'base') return state.anvil.rpcUrl;
  const existing = state.rpcLinks.get(who);
  if (existing) return existing.url;
  const link = await startRpcProxy({ upstream: state.anvil.rpcUrl, seed: derive(plan.seed, `rpc:${who}`), chain: chainClock });
  assertLocalUrl(link.url, `${who} RPC link`);
  state.rpcLinks.set(who, link);
  log(`Base-like RPC link for ${who} on ${link.url}`);
  return link.url;
}

function watchdogStatus() {
  const now = Date.now();
  return { starter: watch.starter, idleMinutes: watch.idleMinutes, heartbeatAgoMs: now - watch.heartbeatAt, lastControlRequestAgoMs: now - watch.previousRequestAt };
}

const isStarter = (entry) => Boolean(watch.starter) && entry.pid === watch.starter.pid && entry.startedAt === watch.starter.startedAt;

/** Runs only once startup is done: a shutdown racing main() could miss what main() spawns next. */
function startWatchdog() {
  watch.heartbeatAt = Date.now();
  watch.lastRequestAt = Date.now();
  watch.previousRequestAt = Date.now();
  const timer = setInterval(() => {
    if (shuttingDown) { clearInterval(timer); return; }
    const now = Date.now();
    const decision = watchdogDecision({
      starter: !watch.starter ? 'none' : isOwnedProcessAlive(watch.starter) ? 'alive' : 'dead',
      heartbeatAgeMs: now - watch.heartbeatAt,
      lastControlAgeMs: now - watch.lastRequestAt,
      idleMs: watch.idleMinutes * 60_000,
    });
    if (decision === 'keep') return;
    clearInterval(timer);
    const reason = decision.slice('stop:'.length);
    log(`Watchdog: ${reason === 'idle' ? `no control request for ${watch.idleMinutes} min` : `starter ${watch.starter.pid} is gone`}; stopping (${reason})`);
    void writeManifest({ stoppedBy: 'watchdog', reason }).finally(() => shutdown(reason));
  }, WATCHDOG_INTERVAL_MS);
}

async function shutdown(reason) {
  if (shuttingDown) return shuttingDown;
  shuttingDown = (async () => {
    log(`Shutting down (${reason})`);
    const errors = [];
    const step = async (label, action) => {
      try { await action(); } catch (error) { errors.push(`${label}: ${error.message}`); log(`${label} failed: ${error.message}`); }
    };
    if (manifest?.running) await writeManifest({ running: false, stoppingAt: new Date().toISOString() });
    if (state.buyer && state.reader && manifest?.sellers) {
      await step('settle and close channels', async () => {
        const summary = await closeChannels(manifest.sellers.map((seller) => seller.id).filter((id) => state.workers.has(id)));
        log(`Channels: ${JSON.stringify(summary.results)} reserved=${summary.buyer.reservedMicroUsdc}`);
        await writeManifest({ finalBalances: summary.buyer });
      });
    }
    await step('control', async () => state.control?.stop());
    await step('proxy', async () => state.proxy?.stop());
    await step('buyer', async () => state.buyer?.stop());
    for (const id of [...state.workers.keys()]) await step(`seller ${id}`, () => stopSellerWorker(id));
    await step('bootstrap', async () => state.bootstrap?.stop());
    for (const [who, link] of state.rpcLinks) await step(`rpc link ${who}`, () => link.close());
    for (const [id, mock] of state.mocks) await step(`mock ${id}`, () => mock.stop());
    state.reader?.close();
    if (state.anvil?.child && state.anvil.child.exitCode === null) {
      await step('anvil', async () => {
        const exited = once(state.anvil.child, 'exit');
        state.anvil.child.kill('SIGTERM');
        const timer = setTimeout(() => state.anvil.child.kill('SIGKILL'), 30_000);
        try { await exited; } finally { clearTimeout(timer); }
      });
    }
    if (state.rpcRelay) await step('stop fork RPC relay', () => state.rpcRelay.close());
    if (manifest?.forkBlock) {
      await step('cache write-back', async () => log(`Fork cache write-back: ${await writeBack(plan.cacheHome, paths.anvilHome, manifest.forkBlock)}`));
      await step('cache prune', async () => {
        const inUse = await blocksInUse(paths.root);
        inUse.add(manifest.forkBlock);
        const removed = await pruneCache(plan.cacheHome, { inUse });
        if (removed.length) log(`Pruned fork cache blocks ${removed.join(', ')}`);
      });
    }
    if (manifest) await writeManifest({ running: false, stoppedAt: new Date().toISOString(), shutdownErrors: errors });
    // Only the supervisor that holds the lock owns control.json; a loser of a start race must not wipe the winner's.
    if (lockEntry) await saveJson(paths.control, {}).catch(() => {});
    if (lockEntry) await releaseLock(paths.lock, lockEntry);
    log(errors.length ? `Stopped with errors: ${errors.join('; ')}` : 'Stopped cleanly');
    process.exitCode = errors.length ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 200).unref();
  })();
  return shuttingDown;
}

async function main() {
  const lock = await acquireLock(paths.lock, { name, role: 'supervisor' });
  if (lock.state !== 'acquired') throw new Error(`Testbench ${name} is already running (pid ${lock.holder.pid})`);
  lockEntry = lock.entry;
  const wiped = await resetRunState(paths);
  for (const dir of [paths.home, join(paths.home, '.antseed'), paths.anvilHome, paths.buyer, paths.sellers, paths.logs, paths.reports]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  startReaper();
  log(`Fresh ${target} run: cleared ${wiped.length} stale state entries (identities kept)`);
  const clean = isolatedEnv(process.env, paths.home, { ...plan.topology.buyer.env, ...(plan.verbose ? { ANTSEED_DEBUG: '1' } : {}) });
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  Object.assign(process.env, clean);

  manifest = {
    version: MANIFEST_VERSION, name, target, mode: plan.mode, running: false, starting: true, dir: paths.dir, worktree: plan.worktree,
    supervisor: ownProcessEntry(), starter: watch.starter, idleMinutes: watch.idleMinutes, home: paths.home, buyerDir: paths.buyer, buyerConfig: join(paths.buyer, 'config.json'),
    chainId: TESTBENCH_CHAIN_IDS[target], configHash: plan.configHash, configOrigin: plan.configOrigin, upstream: plan.upstream,
    topology: plan.topology, seed: plan.seed, startedAt: new Date().toISOString(), logStart: logOffsets(peerLogs(paths.logs).all),
    rpcUrl: 'http://127.0.0.1:1', proxyUrl: 'http://127.0.0.1:1', sellers: [],
  };
  await saveJson(paths.manifest, manifest);

  if (local) {
    state.anvil = await startAnvil(null, undefined, { timestamp: localGenesisTimestamp(plan.topology.chain?.contracts ?? 'full') });
    await writeManifest({ rpcUrl: state.anvil.rpcUrl, anvil: { pid: state.anvil.child.pid, startedAt: processStartTime(state.anvil.child.pid), port: state.anvil.port } });
    const layout = plan.topology.chain?.contracts ?? 'full';
    log(`Local Anvil (chain ${TESTBENCH_CHAIN_IDS.local}) on ${state.anvil.rpcUrl}; deploying packages/contracts from source (${layout} layout)`);
    const deployed = await deployLocalStack({ repo, rpcUrl: state.anvil.rpcUrl, layout, logPath: join(paths.logs, 'forge.log'), broadcastDir: join(paths.anvilHome, 'broadcast'), toolHome, log, onSpawn: reap });
    await writeManifest({ localDeploy: { layout, timingsMs: deployed.timings } });
    log(`Contracts deployed (${layout}): ${Object.entries(deployed.timings).map(([step, ms]) => `${step} ${(ms / 1000).toFixed(1)}s`).join(', ')}`);
  } else {
    log(`Seeded shared fork cache: ${(await seedFromLegacy(plan.cacheHome, plan.legacyCacheHome)) ?? 'not needed'}`);
    const fork = await resolveForkBlock({ forkUrl: forkUrl, cacheHome: plan.cacheHome, explicitBlock: plan.topology.chain.block });
    const copied = await copyIn(plan.cacheHome, paths.anvilHome, fork.block);
    log(`Fork block ${fork.block} (${fork.source}); private cache copy: ${copied ? 'warm' : 'cold'}`);
    await writeManifest({ forkBlock: fork.block, forkCache: { ...fork, copied } });
    state.rpcRelay = await startRpcRelay(forkUrl);
    state.anvil = await startAnvil(state.rpcRelay.url, fork.block);
    await writeManifest({ rpcUrl: state.anvil.rpcUrl, anvil: { pid: state.anvil.child.pid, startedAt: processStartTime(state.anvil.child.pid), port: state.anvil.port } });
    log(`Anvil fork on ${state.anvil.rpcUrl}`);
  }

  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  const BuyerProxy = cliMode ? null : (await import(join(repo, 'apps/cli/dist/proxy/buyer-proxy.js'))).BuyerProxy;
  const buyerIdentity = await sdk.loadOrCreateIdentity(paths.buyer);
  const sellerIdentities = [];
  for (const seller of plan.topology.sellers) {
    await mkdir(paths.seller(seller.id), { recursive: true, mode: 0o700 });
    sellerIdentities.push({ id: seller.id, identity: await sdk.loadOrCreateIdentity(paths.seller(seller.id)) });
  }
  const chainState = await (local ? prepareLocalChain : prepareChain)({
    rpcUrl: state.anvil.rpcUrl, sdk, sellers: sellerIdentities, buyer: buyerIdentity,
    depositMicros: BigInt(plan.topology.buyer.depositMicros), topUpThresholdBps: plan.topology.chain?.topUpThresholdBps, log,
    ...(local ? { layout: plan.topology.chain?.contracts ?? 'full' } : {}),
  });
  state.reader = chainReader(state.anvil.rpcUrl, chainState.chain);
  const chainTimestamp = Number((await state.reader.provider.getBlock('latest')).timestamp);
  const paymentOptions = { chainTimestamp, ...(plan.topology.payments?.settlementIdleMs ? { settlementIdleMs: plan.topology.payments.settlementIdleMs } : {}) };
  // Setup ran on automine; Base-like runs then switch Anvil to fixed block times (Base: 2 s) for the rest of the testbench.
  if (plan.topology.chain?.blockTimeSec) {
    await state.reader.provider.send('evm_setIntervalMining', [plan.topology.chain.blockTimeSec]);
    log(`Anvil mines a block every ${plan.topology.chain.blockTimeSec}s`);
  }

  state.bootstrap = new sdk.DHTNode({ peerId: sdk.toPeerId('0'.repeat(40)), port: 0, bindHost: '127.0.0.1', bootstrapNodes: [], reannounceIntervalMs: 60_000, operationTimeoutMs: 5000, allowPrivateIPs: true });
  await state.bootstrap.start();
  const bootstrapNodes = [{ host: '127.0.0.1', port: state.bootstrap.getPort() }];
  log(`Private bootstrap DHT on 127.0.0.1:${state.bootstrap.getPort()}`);

  if (cliMode) {
    const providerPlugins = plan.topology.sellers.flatMap((seller) => Object.values(seller.providers).map((provider) => WORKSPACE_PLUGINS[provider.plugin]));
    await linkPlugins(paths.home, repo, ['router-local', ...providerPlugins]);
  }
  const sellers = [];
  for (const seller of plan.topology.sellers) {
    let mockUrl;
    if (plan.upstream === 'mock') {
      const mock = await startMock({ models: [...new Set(Object.values(seller.providers).flatMap((p) => Object.keys(p.services)))], label: `testbench seller ${seller.id}`, ...seller.mock, pricing: mockPricing(seller.providers), random: createPrng(derive(plan.seed, `mock:${seller.id}`)) });
      state.mocks.set(seller.id, mock);
      mockUrl = mock.url;
    }
    const { providers, sellerEnv } = bindUpstream({ seller: { providers: seller.providers } }, { mode: plan.upstream, mockUrl, env: liveEnv });
    const configPath = join(paths.seller(seller.id), 'config.json');
    const sellerRpc = await chainLink(`seller:${seller.id}`);
    const spec = { id: seller.id, dataDir: paths.seller(seller.id), configPath, bootstrapNodes, payments: { ...paymentsConfig(chainState.chain, sellerRpc, paymentOptions), ...(plan.topology.payments?.minBudgetPerRequestMicros ? { minBudgetPerRequest: plan.topology.payments.minBudgetPerRequestMicros } : {}) }, env: { ...seller.env, ...sellerEnv } };
    if (cliMode) {
      await saveJson(configPath, assertCliConfig(cliSellerConfig({ id: seller.id, providers, chain: chainState.chain, bootstrapNodes, payments: spec.payments, freeTier: seller.freeTier }), 'seller'));
      // The CLI reads the idle-settle timer from this variable only.
      if (paymentOptions.settlementIdleMs) spec.env = { ...spec.env, ANTSEED_SETTLEMENT_IDLE_MS: String(paymentOptions.settlementIdleMs) };
    } else {
      await saveJson(configPath, { seller: { providers }, payments: { crypto: { ...chainState.chain, rpcUrl: sellerRpc, networkStatsUrl: '', explorerApiUrl: '' } }, network: { bootstrapNodes: bootstrapNodes.map((n) => `${n.host}:${n.port}`) }, relayer: { enabled: false } });
    }
    const worker = await startSeller(spec);
    assert.equal(worker.info.peerId, sellerIdentities.find((entry) => entry.id === seller.id).identity.peerId, `seller ${seller.id} started with another identity`);
    const chainSeller = chainState.sellers.find((entry) => entry.id === seller.id);
    sellers.push({ id: seller.id, peerId: worker.info.peerId, address: chainSeller.address, agentId: chainSeller.agentId, dhtPort: worker.info.dhtPort, signalingPort: worker.info.signalingPort, process: worker.process, mockUrl: mockUrl ?? null, models: listModels({ seller: { providers } }), spec });
    log(`Seller ${seller.id} peer ${worker.info.peerId}`);
  }

  const routingPreferences = buyerRoutingPreferences(plan.topology, sellers.map((seller) => seller.peerId));
  const buyerCaps = { ...(plan.topology.buyer.maxReserveMicros ? { maxReserveAmountUsdc: plan.topology.buyer.maxReserveMicros } : {}), ...(plan.topology.buyer.maxPerRequestMicros ? { maxPerRequestUsdc: plan.topology.buyer.maxPerRequestMicros } : {}) };
  const buyerPayments = { ...paymentsConfig(chainState.chain, await chainLink('buyer'), paymentOptions), ...buyerCaps };
  buyerRuntime = { sdk, BuyerProxy, peerId: buyerIdentity.peerId, bootstrapNodes, payments: buyerPayments, chain: chainState.chain, routingPreferences };
  const proxyPort = await startBuyer();
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  assertLocalUrl(proxyUrl, 'proxyUrl');
  const buyerStatus = await (await fetch(`${proxyUrl}/_antseed/status`)).json();
  await copyFile(join(paths.buyer, 'identity.key'), join(paths.home, '.antseed', 'identity.key'));
  await chmod(join(paths.home, '.antseed', 'identity.key'), 0o600);

  await writeManifest({
    proxyUrl, proxyPort, buyerStartedAt: buyerStatus.startedAt,
    buyer: { peerId: state.buyer.peerId, address: chainState.buyer, dhtPort: state.buyer.dhtPort },
    sellers: sellers.map(({ spec, ...rest }) => rest),
    bootstrap: { host: '127.0.0.1', port: state.bootstrap.getPort() },
    chain: { deposits: chainState.chain.depositsContractAddress, channels: chainState.chain.channelsContractAddress, usdc: chainState.chain.usdcContractAddress, contracts: chainContracts(chainState.chain, local ? plan.topology.chain?.contracts ?? 'full' : null) },
    stakeToken: chainState.stakeToken,
    chainStartBlock: chainState.startBlock, sellerUsdcBefore: chainState.sellerUsdcBefore, depositMicros: chainState.depositMicros, stake: chainState.stake,
    ownerSettings: chainState.ownerSettings, rpcProfile: plan.topology.chain?.rpc ?? 'direct',
    rpcLinks: Object.fromEntries([...state.rpcLinks].map(([who, link]) => [who, link.url])),
    desktopInstance: name.slice(0, 40),
  });
  const specs = new Map(sellers.map((seller) => [seller.id, seller.spec]));
  await discover(sellers.map((seller) => seller.id));
  log('Buyer discovered all testbench sellers');

  const token = newToken();
  state.control = await startControlServer({
    token, log,
    onRequest: () => { watch.previousRequestAt = watch.lastRequestAt; watch.lastRequestAt = Date.now(); },
    routes: {
      // Any driver's beat counts as a control request; only the starter's holds off the watchdog's grace.
      'POST /heartbeat': ({ body }) => {
        if (isStarter(body)) watch.heartbeatAt = Date.now();
        return watchdogStatus();
      },
      'POST /starter/release': async ({ body }) => {
        if (isStarter(body)) {
          log(`Starter ${watch.starter.pid} released the testbench; the idle budget applies now`);
          watch.starter = null;
          await writeManifest({ starter: null });
        }
        return watchdogStatus();
      },
      'GET /status': () => liveStatus(),
      'POST /channels/close': ({ body }) => closeChannels(body.sellerId ? [body.sellerId] : manifest.sellers.map((seller) => seller.id)),
      'POST /chain/warp': async ({ body }) => {
        const seconds = Number(body.seconds);
        if (!Number.isInteger(seconds) || seconds <= 0 || seconds > 365 * 86_400) throw Object.assign(new Error('seconds must be 1..31536000'), { statusCode: 400 });
        await state.reader.warp(seconds);
        return { block: await state.reader.provider.getBlockNumber() };
      },
      'POST /sellers/:id/stop': async ({ params }) => {
        if (!specs.has(params.id)) throw Object.assign(new Error(`Unknown seller ${params.id}`), { statusCode: 404 });
        const stopped = await stopSellerWorker(params.id);
        await writeManifest({ sellers: manifest.sellers.map((seller) => (seller.id === params.id ? { ...seller, process: undefined, online: false } : seller)) });
        return { stopped };
      },
      'POST /sellers/:id/start': async ({ params }) => {
        const spec = specs.get(params.id);
        if (!spec) throw Object.assign(new Error(`Unknown seller ${params.id}`), { statusCode: 404 });
        if (state.workers.has(params.id)) return { started: false };
        const worker = await startSeller(spec);
        await writeManifest({ sellers: manifest.sellers.map((seller) => (seller.id === params.id ? { ...seller, process: worker.process, online: true, dhtPort: worker.info.dhtPort, signalingPort: worker.info.signalingPort } : seller)) });
        await discover([params.id]);
        return { started: true };
      },
      'POST /buyer/stop': async () => {
        const stopped = await stopBuyer();
        await writeManifest({ buyerOnline: false });
        log('Buyer node and proxy stopped (control request)');
        return { stopped };
      },
      'POST /buyer/start': async () => {
        if (state.buyer) return { started: false };
        await startBuyer(manifest.proxyPort);
        const status = await (await fetch(`${manifest.proxyUrl}/_antseed/status`)).json();
        await writeManifest({ buyerOnline: true, buyerStartedAt: status.startedAt });
        await discover(manifest.sellers.filter((seller) => state.workers.has(seller.id)).map((seller) => seller.id));
        log('Buyer node and proxy restarted on the same port');
        return { started: true };
      },
      'GET /faults/buyer/need-auth-loss': () => state.needAuthLoss,
      'POST /faults/buyer/need-auth-loss': ({ body }) => {
        if (cliMode) throw Object.assign(new Error('The NeedAuth-loss fault hooks an in-process buyer; this testbench runs the CLI buyer (--mode cli), use --mode sdk'), { statusCode: 409 });
        if (!state.buyer?.buyerPaymentManager) throw Object.assign(new Error('The buyer has no payment manager'), { statusCode: 409 });
        const count = Number(body.count);
        if (!Number.isInteger(count) || count < 0 || count > 10) throw Object.assign(new Error('count must be 0..10'), { statusCode: 400 });
        state.needAuthLoss = { remaining: count, lost: [] };
        log(`Fault: the buyer loses the next ${count} NeedAuth frame(s) (control request)`);
        return state.needAuthLoss;
      },
      'POST /sellers/:id/mock': ({ params, body }) => {
        const mock = state.mocks.get(params.id);
        if (!mock) throw Object.assign(new Error(`No mock for seller ${params.id}`), { statusCode: 404 });
        const bad = (message) => Object.assign(new Error(message), { statusCode: 400 });
        if (body.latencyMs !== undefined) {
          const latencyMs = Number(body.latencyMs);
          if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) throw bad('latencyMs must be 0..60000');
          mock.setLatency(latencyMs);
        }
        const faults = {};
        for (const key of ['fault500Rate', 'disconnectRate']) {
          if (body[key] === undefined) continue;
          if (typeof body[key] !== 'number' || !(body[key] >= 0 && body[key] <= 1)) throw bad(`${key} must be 0..1`);
          faults[key] = body[key];
        }
        if (Object.keys(faults).length) log(`Mock ${params.id} faults ${JSON.stringify(mock.setFaults(faults))} (control request)`);
        return { latencyMs: mock.state.latencyMs, faults: mock.state.faults };
      },
      'GET /sellers/:id/deliveries': ({ params }) => {
        const mock = state.mocks.get(params.id);
        if (!mock) throw Object.assign(new Error(`No mock for seller ${params.id}`), { statusCode: 404 });
        return mock.deliveries();
      },
      'GET /health': () => ({ ...state.health, rpc: rpcStats() }),
      'GET /sellers/:id/mock': ({ params }) => {
        const mock = state.mocks.get(params.id);
        if (!mock) throw Object.assign(new Error(`No mock for seller ${params.id}`), { statusCode: 404 });
        return { requests: mock.state.requests };
      },
      'POST /shutdown': () => {
        setTimeout(() => void shutdown('control request'), 10);
        return { stopping: true };
      },
    },
  });
  await saveJson(paths.control, { url: state.control.url, token });
  await writeManifest({ controlUrl: state.control.url, running: true, starting: false, readyAt: new Date().toISOString() });
  validateManifest(manifest, { dir: paths.dir });
  log(`READY proxy=${proxyUrl} rpc=${state.anvil.rpcUrl} control=${state.control.url}`);
  startWatchdog();

  state.anvil.child.on('exit', (code) => {
    if (!shuttingDown) void shutdown(`anvil exited (${code})`);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error) => {
  log(`unhandled rejection: ${error?.stack ?? error}`);
  state.health.unhandledRejections.push({ message: String(error?.message ?? error).slice(0, 400), at: new Date().toISOString() });
});

try {
  await main();
} catch (error) {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (manifest) await writeManifest({ startError: error.message }).catch(() => {});
  await shutdown('startup failure');
  process.exitCode = 1;
}

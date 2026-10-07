#!/usr/bin/env node
// Long-lived sandbox owner: Anvil fork, private bootstrap, mocks, seller workers, buyer + proxy, control API.
// Started detached by `pnpm sandbox up`; stopped by `pnpm sandbox down` (POST /shutdown) or SIGTERM.
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { chmod, copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bindUpstream, listModels } from './lib/config.mjs';
import { blocksInUse, copyIn, pruneCache, resolveForkBlock, seedFromLegacy, writeBack } from './lib/cache.mjs';
import { chainReader, prepareChain } from './lib/chain.mjs';
import { newToken, startControlServer } from './lib/control.mjs';
import { assertLocalUrl, isolatedEnv, listenWithRetry } from './lib/env.mjs';
import { acquireLock, ownProcessEntry, processStartTime, releaseLock } from './lib/lock.mjs';
import { saveJson, validateManifest, MANIFEST_VERSION } from './lib/manifest.mjs';
import { startMock } from './lib/mock.mjs';
import { paymentsConfig, sandboxNodeOptions } from './lib/node-options.mjs';
import { resetRunState, sandboxPaths } from './lib/paths.mjs';
import { buyerRoutingPreferences } from './lib/topology.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../..');
const [root, name] = process.argv.slice(2);
const paths = sandboxPaths(root, name);
const plan = JSON.parse(await readFile(join(paths.config, 'plan.json'), 'utf8'));
// Secrets never go into plan.json: the fork RPC URL and live API keys arrive via env and are read before it is cleaned.
const forkUrl = process.env.ANTSEED_SANDBOX_FORK_URL;
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

const state = { anvil: null, bootstrap: null, mocks: new Map(), workers: new Map(), buyer: null, proxy: null, control: null, reader: null };
let manifest = null;
let lockEntry = null;
let shuttingDown = null;

async function writeManifest(patch) {
  manifest = { ...manifest, ...patch, updatedAt: new Date().toISOString() };
  await saveJson(paths.manifest, manifest);
}

async function startAnvil(forkUrl, block) {
  const logStream = createWriteStream(join(paths.logs, 'anvil.log'), { flags: 'a' });
  const { port, value: child } = await listenWithRetry(async (candidate) => {
    const args = [
      '--fork-url', forkUrl, '--fork-block-number', String(block), '--chain-id', '8453',
      '--host', '127.0.0.1', '--port', String(candidate),
      '--no-rate-limit', '--retries', '20', '--timeout', '120000',
      '--disable-min-priority-fee', '--base-fee', '0', '--gas-price', '0',
    ];
    const spawned = spawn('anvil', args, { env: isolatedEnv(process.env, paths.anvilHome), stdio: ['ignore', 'pipe', 'pipe'] });
    spawned.stdout.pipe(logStream, { end: false });
    spawned.stderr.pipe(logStream, { end: false });
    const rpcUrl = `http://127.0.0.1:${candidate}`;
    try {
      await waitFor(async () => {
        if (spawned.exitCode !== null) {
          const error = new Error(`Anvil exited with ${spawned.exitCode}`);
          error.code = 'EADDRINUSE';
          throw error;
        }
        try {
          const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }), signal: AbortSignal.timeout(2000) });
          return (await response.json()).result === '0x2105';
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

function spawnSeller(seller, env) {
  const logStream = createWriteStream(join(paths.logs, `seller-${seller.id}.log`), { flags: 'a' });
  const child = fork(join(here, 'seller-worker.mjs'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
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
  const entry = { child, info, process: { pid: child.pid, startedAt: processStartTime(child.pid) } };
  state.workers.set(seller.id, entry);
  return entry;
}

async function stopSellerWorker(id) {
  const worker = state.workers.get(id);
  if (!worker) return false;
  state.workers.delete(id);
  if (worker.child.exitCode === null && worker.child.signalCode === null) {
    const exited = once(worker.child, 'exit');
    worker.child.send({ type: 'stop' });
    const timer = setTimeout(() => worker.child.kill('SIGKILL'), 15_000);
    try { await exited; } finally { clearTimeout(timer); }
  }
  return true;
}

async function discover(sellerIds) {
  await waitFor(async () => {
    for (const id of sellerIds) state.workers.get(id)?.child.send({ type: 'announce' });
    const peers = await state.buyer.discoverPeers();
    return sellerIds.every((id) => peers.some((peer) => peer.peerId === state.workers.get(id)?.info.peerId));
  }, 'buyer discovering sandbox sellers', 90_000, 1000);
  const response = await fetch(`${manifest.proxyUrl}/_antseed/peers/refresh`, { method: 'POST', signal: AbortSignal.timeout(60_000) });
  assert(response.ok, 'proxy peer refresh failed');
}

async function closeChannels(sellerIds) {
  const results = {};
  for (const id of sellerIds) {
    const seller = manifest.sellers.find((entry) => entry.id === id);
    if (!seller) throw Object.assign(new Error(`Unknown seller ${id}`), { statusCode: 404 });
    const active = state.buyer.getActiveBuyerChannels().filter((channel) => channel.peerId === seller.peerId);
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
  await waitFor(async () => (await state.reader.buyerBalance(manifest.buyer.address)).reserved === 0n || Object.values(results).includes('seller-offline'), 'reserves released', 120_000, 500);
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
      channels: state.buyer.getActiveBuyerChannels(),
      chainBlock: await state.reader.provider.getBlockNumber(),
    },
  };
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
    await saveJson(paths.control, {}).catch(() => {});
    if (lockEntry) await releaseLock(paths.lock, lockEntry);
    log(errors.length ? `Stopped with errors: ${errors.join('; ')}` : 'Stopped cleanly');
    process.exitCode = errors.length ? 1 : 0;
    setTimeout(() => process.exit(process.exitCode), 200).unref();
  })();
  return shuttingDown;
}

async function main() {
  const lock = await acquireLock(paths.lock, { name, role: 'supervisor' });
  if (lock.state !== 'acquired') throw new Error(`Sandbox ${name} is already running (pid ${lock.holder.pid})`);
  lockEntry = lock.entry;
  const wiped = await resetRunState(paths);
  for (const dir of [paths.home, join(paths.home, '.antseed'), paths.anvilHome, paths.buyer, paths.sellers, paths.logs, paths.reports]) {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  }
  log(`Fresh fork run: cleared ${wiped.length} stale state entries (identities kept)`);
  const clean = isolatedEnv(process.env, paths.home, plan.verbose ? { ANTSEED_DEBUG: '1' } : {});
  for (const key of Object.keys(process.env)) if (!(key in clean)) delete process.env[key];
  Object.assign(process.env, clean);

  manifest = {
    version: MANIFEST_VERSION, name, target: 'fork', running: false, starting: true, dir: paths.dir, worktree: plan.worktree,
    supervisor: ownProcessEntry(), home: paths.home, buyerDir: paths.buyer, buyerConfig: join(paths.buyer, 'config.json'),
    chainId: 8453, configHash: plan.configHash, configOrigin: plan.configOrigin, upstream: plan.upstream,
    topology: plan.topology, startedAt: new Date().toISOString(),
    rpcUrl: 'http://127.0.0.1:1', proxyUrl: 'http://127.0.0.1:1', sellers: [],
  };
  await saveJson(paths.manifest, manifest);

  log(`Seeded shared fork cache: ${(await seedFromLegacy(plan.cacheHome, plan.legacyCacheHome)) ?? 'not needed'}`);
  const fork = await resolveForkBlock({ forkUrl: forkUrl, cacheHome: plan.cacheHome, explicitBlock: plan.topology.chain.block });
  const copied = await copyIn(plan.cacheHome, paths.anvilHome, fork.block);
  log(`Fork block ${fork.block} (${fork.source}); private cache copy: ${copied ? 'warm' : 'cold'}`);
  await writeManifest({ forkBlock: fork.block, forkCache: { ...fork, copied } });
  state.anvil = await startAnvil(forkUrl, fork.block);
  await writeManifest({ rpcUrl: state.anvil.rpcUrl, anvil: { pid: state.anvil.child.pid, startedAt: processStartTime(state.anvil.child.pid), port: state.anvil.port } });
  log(`Anvil fork on ${state.anvil.rpcUrl}`);

  const sdk = await import(join(repo, 'packages/node/dist/index.js'));
  const { BuyerProxy } = await import(join(repo, 'apps/cli/dist/proxy/buyer-proxy.js'));
  const buyerIdentity = await sdk.loadOrCreateIdentity(paths.buyer);
  const sellerIdentities = [];
  for (const seller of plan.topology.sellers) {
    await mkdir(paths.seller(seller.id), { recursive: true, mode: 0o700 });
    sellerIdentities.push({ id: seller.id, identity: await sdk.loadOrCreateIdentity(paths.seller(seller.id)) });
  }
  const chainState = await prepareChain({
    rpcUrl: state.anvil.rpcUrl, sdk, sellers: sellerIdentities, buyer: buyerIdentity,
    depositMicros: BigInt(plan.topology.buyer.depositMicros), log,
  });
  state.reader = chainReader(state.anvil.rpcUrl, chainState.chain);
  const chainTimestamp = Number((await state.reader.provider.getBlock('latest')).timestamp);
  const payments = paymentsConfig(chainState.chain, state.anvil.rpcUrl, { chainTimestamp });

  state.bootstrap = new sdk.DHTNode({ peerId: sdk.toPeerId('0'.repeat(40)), port: 0, bindHost: '127.0.0.1', bootstrapNodes: [], reannounceIntervalMs: 60_000, operationTimeoutMs: 5000, allowPrivateIPs: true });
  await state.bootstrap.start();
  const bootstrapNodes = [{ host: '127.0.0.1', port: state.bootstrap.getPort() }];
  log(`Private bootstrap DHT on 127.0.0.1:${state.bootstrap.getPort()}`);

  const sellers = [];
  for (const seller of plan.topology.sellers) {
    let mockUrl;
    if (plan.upstream === 'mock') {
      const mock = await startMock({ models: [...new Set(Object.values(seller.providers).flatMap((p) => Object.keys(p.services)))], label: `sandbox seller ${seller.id}`, latencyMs: seller.mock.latencyMs });
      state.mocks.set(seller.id, mock);
      mockUrl = mock.url;
    }
    const { providers, sellerEnv } = bindUpstream({ seller: { providers: seller.providers } }, { mode: plan.upstream, mockUrl, env: liveEnv });
    const configPath = join(paths.seller(seller.id), 'config.json');
    await saveJson(configPath, { seller: { providers }, payments: { crypto: { ...chainState.chain, networkStatsUrl: '', explorerApiUrl: '' } }, network: { bootstrapNodes: bootstrapNodes.map((n) => `${n.host}:${n.port}`) }, relayer: { enabled: false } });
    const spec = { id: seller.id, dataDir: paths.seller(seller.id), configPath, bootstrapNodes, payments, env: sellerEnv };
    const worker = await startSellerWorker(spec);
    const chainSeller = chainState.sellers.find((entry) => entry.id === seller.id);
    sellers.push({ id: seller.id, peerId: worker.info.peerId, address: chainSeller.address, agentId: chainSeller.agentId, dhtPort: worker.info.dhtPort, signalingPort: worker.info.signalingPort, process: worker.process, mockUrl: mockUrl ?? null, models: listModels({ seller: { providers } }), spec });
    log(`Seller ${seller.id} peer ${worker.info.peerId}`);
  }

  state.buyer = new sdk.AntseedNode(sandboxNodeOptions({ role: 'buyer', dataDir: paths.buyer, bootstrapNodes, payments }));
  await state.buyer.start();
  const routingPreferences = buyerRoutingPreferences(plan.topology, sellers.map((seller) => seller.peerId));
  const { port: proxyPort, value: proxy } = await listenWithRetry(async (port) => {
    await saveJson(manifest.buyerConfig, {
      buyer: { proxyPort: port, minPeerReputation: 0, routingPreferences, ...(plan.topology.buyer.maxPricing ? { maxPricing: plan.topology.buyer.maxPricing } : {}) },
      payments: { crypto: { ...chainState.chain, networkStatsUrl: '', explorerApiUrl: '' } },
      network: { bootstrapNodes: bootstrapNodes.map((n) => `${n.host}:${n.port}`) },
      relayer: { enabled: false },
    });
    const { loadConfig } = await import(join(repo, 'apps/cli/dist/config/loader.js'));
    const loaded = await loadConfig(manifest.buyerConfig);
    const candidate = new BuyerProxy({ node: state.buyer, port, dataDir: paths.buyer, configPath: manifest.buyerConfig, routingPreferences: loaded.buyer.routingPreferences, backgroundRefreshIntervalMs: 60_000 });
    await candidate.start();
    return candidate;
  });
  state.proxy = proxy;
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
    chain: { deposits: chainState.chain.depositsContractAddress, channels: chainState.chain.channelsContractAddress, usdc: chainState.chain.usdcContractAddress },
    chainStartBlock: chainState.startBlock, sellerUsdcBefore: chainState.sellerUsdcBefore, depositMicros: chainState.depositMicros, stake: chainState.stake,
    desktopInstance: name.slice(0, 40),
  });
  const specs = new Map(sellers.map((seller) => [seller.id, seller.spec]));
  await discover(sellers.map((seller) => seller.id));
  log('Buyer discovered all sandbox sellers');

  const token = newToken();
  state.control = await startControlServer({
    token, log,
    routes: {
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
        const worker = await startSellerWorker(spec);
        await writeManifest({ sellers: manifest.sellers.map((seller) => (seller.id === params.id ? { ...seller, process: worker.process, online: true, dhtPort: worker.info.dhtPort, signalingPort: worker.info.signalingPort } : seller)) });
        await discover([params.id]);
        return { started: true };
      },
      'POST /sellers/:id/mock': ({ params, body }) => {
        const mock = state.mocks.get(params.id);
        if (!mock) throw Object.assign(new Error(`No mock for seller ${params.id}`), { statusCode: 404 });
        const latencyMs = Number(body.latencyMs);
        if (!Number.isInteger(latencyMs) || latencyMs < 0 || latencyMs > 60_000) throw Object.assign(new Error('latencyMs must be 0..60000'), { statusCode: 400 });
        mock.setLatency(latencyMs);
        return { latencyMs };
      },
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

  for (const worker of state.workers.values()) {
    worker.child.on('exit', (code) => log(`Seller worker ${worker.child.pid} exited (${code})`));
  }
  state.anvil.child.on('exit', (code) => {
    if (!shuttingDown) void shutdown(`anvil exited (${code})`);
  });
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (error) => log(`unhandled rejection: ${error?.stack ?? error}`));

try {
  await main();
} catch (error) {
  log(`FAILED: ${error.stack ?? error.message}`);
  if (manifest) await writeManifest({ startError: error.message }).catch(() => {});
  await shutdown('startup failure');
  process.exitCode = 1;
}

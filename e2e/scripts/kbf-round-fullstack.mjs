#!/usr/bin/env node
// Full-stack rehearsal of one distributed KBF verification round on a Base mainnet fork.
//
// Everything that runs in production runs here as separate processes: two `antseed seller start`
// sellers (one serving the genuine model, one an impostor) bound to staked mainnet agents found
// on the fork at run time,
// a publisher (`antseed verifier publish`) with its own buyer, and three `antseed verifier start`
// verifiers with their own buyers paying through real payment channels. The verification contract
// is deployed with the M003 deploy script. Only the model upstream is local (a deterministic
// OpenAI-compatible stub), and round files go to a shared directory instead of IPFS.
//
// Usage: BASE_MAINNET_RPC_URL=<archive-capable Base RPC> node e2e/scripts/kbf-round-fullstack.mjs
// Needs anvil, cast and forge on PATH and a built workspace (`pnpm run build`).
// KEEP_FULLSTACK_DIR=1 keeps the temp directory (configs, logs, round files) after the run.

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AbiCoder, encryptKeystoreJsonSync, getAddress, Interface, keccak256, toUtf8Bytes, Wallet } from 'ethers';
import { loadOrCreateIdentity } from '@antseed/node';
import { DHTNode } from '@antseed/node/discovery';
import { KbfRoundClient, isZeroHash, kbfEpochDeadlines } from '@antseed/node/payments';
import { startStubUpstream } from './kbf-stub-upstream.mjs';

const roundDist = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', 'apps', 'cli', 'dist', 'verifier', 'round');
const { DirectoryRoundStorage } = await import(join(roundDist, 'storage.js'));
const { seededRanking } = await import(join(roundDist, 'seeded.js'));

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli', 'index.js');
const contractsDir = join(repoRoot, 'packages', 'contracts');
/** Plugins the sellers and buyers load, linked from the workspace into the test HOME's plugin dir. */
const PLUGINS = { 'provider-openai': join(repoRoot, 'plugins', 'provider-openai'), 'router-local': join(repoRoot, 'plugins', 'router-local') };
const deployment = JSON.parse(await readFile(join(contractsDir, 'deployments', 'base-mainnet', 'current.json'), 'utf8'));
const address = (name) => getAddress(deployment.contracts[name].address);

const FORK_URL = process.env.BASE_MAINNET_RPC_URL;
const KEEP = process.env.KEEP_FULLSTACK_DIR === '1';
const MODEL = 'glm-5.3';
const GENUINE_UPSTREAM = 'z-ai/glm-5.3';
const IMPOSTOR_UPSTREAM = 'impostor/glm-lookalike';
/** Newest stake positions searched for two agents with pool power this epoch. */
const AGENT_SEARCH_POSITIONS = 500;
const VERIFICATION_MINTER_ID = keccak256(toUtf8Bytes('antseed.emissions.verification.v1'));
const USDC_DEPOSIT = 20_000_000n;
// Password of the throwaway keystores the publisher and verifiers sign with.
const KEYSTORE_PASSWORD = 'kbf-e2e';
// 100 questions make at least 10 batches, so every target gets all 4 slices.
const PROBES_PER_SERVICE = 100;
const SLICES_PER_SERVICE = 4;
// Short enough that warping to the commit deadline leaves chain time well inside the 15 minutes
// a buyer's ReserveAuth is valid for (wall time + 900 s): backup verifiers may open their first
// channel with a seller after that warp, and the seller's reserve() must still land in time.
const COLLECT_WINDOW = 10 * 60;
const BACKUP_WINDOW = 20 * 60;
const ATTEST_WINDOW = 20 * 60;
const APPLY_FALLBACK_DELAY = 2 * 60 * 60;
/** Epoch time the round needs: the three windows plus setup before the schedule is set. */
const ROUND_HEADROOM = COLLECT_WINDOW + BACKUP_WINDOW + ATTEST_WINDOW + 15 * 60;

const started = Date.now();
const children = [];
let out;
let anvil;
let rpcUrl;

function log(message) {
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${message}`);
}

function check(condition, message) {
  if (!condition) throw new Error(`assertion failed: ${message}`);
  log(`ok: ${message}`);
}

async function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options, env: { ...process.env, ...options.env } });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 4).join(' ')}… failed\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

async function rpc(method, params = []) {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) throw new Error(`${method}: ${payload.error.message}`);
  return payload.result;
}

const funded = new Set();
async function send(from, to, signature, args = []) {
  // Impersonated senders (contracts, other people's wallets) need gas money on the fork.
  if (!funded.has(from)) {
    await rpc('anvil_setBalance', [from, '0x8AC7230489E80000']);
    funded.add(from);
  }
  return run('cast', ['send', '--rpc-url', rpcUrl, '--unlocked', '--from', from, to, signature, ...args]);
}
const call = (to, signature, args = []) => run('cast', ['call', '--rpc-url', rpcUrl, to, signature, ...args]).split(/\s/)[0];
const chainNow = async () => Number(BigInt((await rpc('eth_getBlockByNumber', ['latest', false])).timestamp));

async function warpTo(timestamp) {
  const now = await chainNow();
  if (timestamp <= now) return;
  await rpc('evm_increaseTime', [timestamp - now]);
  await rpc('evm_mine');
  log(`warped chain time +${timestamp - now}s (chain is now ${Math.round((await chainNow()) - Date.now() / 1000)}s ahead of wall time)`);
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) {
      log(`ok: ${label}`);
      return value;
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await sleep(intervalMs);
  }
}

function startProcess(name, command, args, env = {}) {
  const logFile = join(out, 'logs', `${name}.log`);
  const stream = createWriteStream(logFile);
  const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(stream);
  child.stderr.pipe(stream);
  child.exitInfo = null;
  child.on('exit', (code, signal) => { child.exitInfo = { code, signal }; });
  children.push({ name, child, logFile });
  return child;
}

async function ethCall(to, abi, name, args = []) {
  const contract = new Interface([abi]);
  const data = contract.encodeFunctionData(name, args);
  return contract.decodeFunctionResult(name, await rpc('eth_call', [{ to, data }, 'latest']));
}

async function startFork(forkBlockNumber) {
  const port = await freePort();
  rpcUrl = `http://127.0.0.1:${port}`;
  anvil = startProcess(`anvil-${forkBlockNumber ?? 'latest'}`, 'anvil', [
    '--fork-url', FORK_URL, '--chain-id', '8453', '--port', String(port),
    '--block-time', '1', '--auto-impersonate', '--silent',
    ...(forkBlockNumber === undefined ? [] : ['--fork-block-number', String(forkBlockNumber)]),
  ]);
  await waitFor(`anvil fork at ${forkBlockNumber ?? 'the latest block'} is up`, async () => {
    try { return Boolean(await rpc('eth_blockNumber')); } catch { return false; }
  }, 60_000, 500);
}

/** The current epoch on the fork and how much of it is left. */
async function epochTiming(gate) {
  const epoch = BigInt(call(gate, 'currentEpoch()(uint256)'));
  const duration = Number(call(gate, 'epochDuration()(uint256)'));
  const epochStart = Number(call(gate, 'genesis()(uint256)')) + Number(epoch) * duration;
  return { epoch, epochStart, remaining: epochStart + duration - await chainNow() };
}

/**
 * Two agents whose stake gives them pool power this epoch (at least 1 bps, so buyers see them as
 * staked), found from the newest stake positions instead of fixed IDs.
 */
async function findStakedAgents(sellerPools, epoch, count) {
  const [next] = await ethCall(sellerPools, 'function nextPositionId() view returns (uint256)', 'nextPositionId');
  const [total] = await ethCall(sellerPools, 'function totalPowerWeightAtEpoch(uint256) view returns (uint256)', 'totalPowerWeightAtEpoch', [epoch]);
  const seen = new Set();
  const found = [];
  for (let id = next - 1n; id > 0n && id >= next - BigInt(AGENT_SEARCH_POSITIONS) && found.length < count; id--) {
    const [, agentId] = await ethCall(sellerPools,
      'function positions(uint256) view returns (address,uint256,uint256,uint256,uint64,uint64,uint64,bool)', 'positions', [id]);
    if (agentId === 0n || seen.has(agentId)) continue;
    seen.add(agentId);
    const [weight] = await ethCall(sellerPools, 'function poolWeightAtEpoch(uint256,uint256) view returns (uint256)', 'poolWeightAtEpoch', [agentId, epoch]);
    if (total > 0n && weight * 10_000n / total >= 1n) found.push(Number(agentId));
  }
  if (found.length < count) throw new Error(`found ${found.length} agents with pool power in the newest ${AGENT_SEARCH_POSITIONS} stake positions; need ${count}`);
  return found;
}

async function stopProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  for (let i = 0; i < 50 && child.exitCode === null && child.signalCode === null; i++) await sleep(200);
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
}

async function main() {
  if (!FORK_URL) throw new Error('BASE_MAINNET_RPC_URL is required (an archive-capable Base mainnet RPC to fork from)');
  for (const command of ['anvil', 'cast', 'forge']) run('which', [command]);
  for (const file of [cliEntry, ...Object.values(PLUGINS).map((plugin) => join(plugin, 'dist', 'index.js'))]) {
    if (!existsSync(file)) throw new Error(`${file} is missing; run pnpm run build first`);
  }
  out = await mkdtemp(join(tmpdir(), 'antseed-kbf-fullstack-'));
  await mkdir(join(out, 'logs'));
  log(`working directory ${out}`);

  // ── Chain: Base mainnet fork with room for the whole round in the current epoch ──────────
  // Fork at the latest block; if too little of the epoch is left, fork again at an older block
  // of the same epoch. Chain time then trails wall time, which buyer deadlines allow (they only
  // reject a chain that is ahead of them).
  const gate = address('emissionsGate');
  await startFork();
  let timing = await epochTiming(gate);
  if (timing.remaining < ROUND_HEADROOM) {
    const latest = Number(BigInt(await rpc('eth_blockNumber')));
    const sample = 10_000;
    const blockTime = (await chainNow() - Number(BigInt((await rpc('eth_getBlockByNumber', [`0x${(latest - sample).toString(16)}`, false])).timestamp))) / sample;
    const blocksBack = Math.ceil((ROUND_HEADROOM - timing.remaining + 60) / blockTime);
    const epoch = timing.epoch;
    log(`only ${Math.round(timing.remaining / 60)} min left in epoch ${epoch}; forking ${blocksBack} blocks earlier`);
    await stopProcess(anvil);
    await startFork(latest - blocksBack);
    timing = await epochTiming(gate);
    check(timing.epoch === epoch && timing.remaining >= ROUND_HEADROOM, `the older fork has ${Math.round(timing.remaining / 60)} min of epoch ${epoch} left`);
  }
  const { epoch, epochStart } = timing;
  const owner = getAddress(call(gate, 'owner()(address)'));
  log(`fork at epoch ${epoch}, ${((await chainNow()) - epochStart) / 3600 | 0}h into it; protocol owner ${owner}`);

  // ── Identities and funding ───────────────────────────────────────────────────────────────
  const roles = ['seller-genuine', 'seller-impostor', 'publisher', 'verifier-1', 'verifier-2', 'verifier-3'];
  const nodes = {};
  for (const role of roles) {
    const dataDir = join(out, role);
    await mkdir(dataDir, { recursive: true });
    const identity = await loadOrCreateIdentity(dataDir);
    nodes[role] = { role, dataDir, address: getAddress(identity.wallet.address), configPath: join(dataDir, 'config.json') };
  }
  // The publisher and verifiers sign with their own keystores: the buyer identity of their data
  // dir only signs payment authorizations and never pays gas or receives rewards.
  for (const role of ['publisher', 'verifier-1', 'verifier-2', 'verifier-3']) {
    const wallet = Wallet.createRandom();
    const keystore = join(out, `${role}-signer.json`);
    await writeFile(keystore, encryptKeystoreJsonSync({ address: wallet.address, privateKey: wallet.privateKey }, KEYSTORE_PASSWORD, { scrypt: { N: 1024 } }), { mode: 0o600 });
    nodes[role].signer = getAddress(wallet.address);
    nodes[role].keystore = keystore;
  }
  const funder = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
  // Gas for sellers and the dedicated signers only: buyers never send transactions.
  const sellerRoles = ['seller-genuine', 'seller-impostor'];
  for (const account of [owner, funder, ...sellerRoles.map((role) => nodes[role].address), ...roles.flatMap((role) => nodes[role].signer ?? [])]) {
    await rpc('anvil_setBalance', [account, '0x8AC7230489E80000']);
  }
  const usdc = address('usdc');
  const deposits = address('deposits');
  const buyers = ['publisher', 'verifier-1', 'verifier-2', 'verifier-3'].map((role) => nodes[role].address);
  await send(deposits, usdc, 'transfer(address,uint256)', [funder, String(USDC_DEPOSIT * BigInt(buyers.length))]);
  await send(funder, usdc, 'approve(address,uint256)', [deposits, String(USDC_DEPOSIT * BigInt(buyers.length))]);
  for (const buyer of buyers) await send(funder, deposits, 'deposit(address,uint256)', [buyer, String(USDC_DEPOSIT)]);
  log(`deposited ${Number(USDC_DEPOSIT) / 1e6} USDC for each of ${buyers.length} buyers`);

  const identityRegistry = address('identityRegistry');
  const sellerPools = address('sellerPools');
  const agents = await findStakedAgents(sellerPools, epoch, 2);
  const sellers = [['seller-genuine', agents[0]], ['seller-impostor', agents[1]]];
  for (const [role, agentId] of sellers) {
    const previousOwner = getAddress(call(identityRegistry, 'ownerOf(uint256)(address)', [String(agentId)]));
    await send(previousOwner, identityRegistry, 'transferFrom(address,address,uint256)', [previousOwner, nodes[role].address, String(agentId)]);
    nodes[role].agentId = agentId;
    const power = BigInt(call(sellerPools, 'poolWeightAtEpoch(uint256,uint256)(uint256)', [String(agentId), String(epoch)]));
    check(power > 0n, `${role} holds agent ${agentId} with pool power ${power} this epoch`);
  }

  // ── Deploy the verification contract with the M003 deploy script ─────────────────────────
  const nonce = Number(BigInt(await rpc('eth_getTransactionCount', [owner, 'latest'])));
  const deployBlock = Number(BigInt(await rpc('eth_blockNumber')));
  run('forge', [
    'script', 'script/migrations/M003VerificationRegistry/Deploy.s.sol:M003DeployVerificationRegistry',
    '--rpc-url', rpcUrl, '--broadcast', '--unlocked', '--sender', owner, '--slow',
  ], {
    cwd: contractsDir,
    env: {
      EXPECTED_CHAIN_ID: '8453',
      ANTSEED_REGISTRY: address('registry'),
      EXPECTED_IDENTITY_REGISTRY: identityRegistry,
      SELLER_POOLS: sellerPools,
      USAGE_ACCOUNTING: address('usageAccounting'),
      POINTS_POLICY_REGISTRY: address('pointsPolicyRegistry'),
      VERIFICATION_OWNER: owner,
      VERIFICATION_DEPLOYMENT_NONCE: String(nonce),
      VERIFICATION_BONUS_BPS: '0',
    },
  });
  const verification = getAddress(run('cast', ['compute-address', '--nonce', String(nonce), owner]).split(/\s/).at(-1));
  check((await rpc('eth_getCode', [verification, 'latest'])).length > 2, `M003 deployed AntseedKbfVerification at ${verification}`);

  // ── Owner setup: rewards, roles, models, a schedule inside the epoch headroom checked above ──
  const elapsed = (await chainNow()) - epochStart;
  const schedule = [elapsed + COLLECT_WINDOW, BACKUP_WINDOW, ATTEST_WINDOW, PROBES_PER_SERVICE, SLICES_PER_SERVICE];
  await send(owner, gate, 'setMinterController(bytes32,address)', [VERIFICATION_MINTER_ID, verification]);
  await send(owner, verification, 'setPublisher(address)', [nodes.publisher.signer]);
  for (const role of ['verifier-1', 'verifier-2', 'verifier-3']) await send(owner, verification, 'setVerifier(address,bool)', [nodes[role].signer, 'true']);
  await send(owner, verification, 'setModels((bytes32,string)[])', [`[(${keccak256(toUtf8Bytes(MODEL))},${MODEL})]`]);
  await send(owner, verification, 'setRewardsStartEpoch(uint256)', [String(epoch)]);
  await send(owner, verification, 'setSchedule((uint32,uint32,uint32,uint16,uint16))', [`(${schedule.join(',')})`]);
  // The fork joins the epoch hours in, past the default 6-hour grace: without this, verifiers would
  // try to take the epoch over before the publisher commits its plan.
  await send(owner, verification, 'setPublisherGraceSeconds(uint32)', [String(elapsed + COLLECT_WINDOW)]);
  check(BigInt(call(gate, 'controllerEpochBudget(address,uint256)(uint256)', [verification, String(epoch)])) > 0n,
    'the verification minter now pays the new contract this epoch');
  const client = new KbfRoundClient({ rpcUrl, contractAddress: verification, evmChainId: 8453, deploymentBlock: deployBlock });

  // ── Upstream stub and a local DHT ────────────────────────────────────────────────────────
  const stub = await startStubUpstream({
    genuineModels: [GENUINE_UPSTREAM],
    catalog: [
      { id: GENUINE_UPSTREAM, inputUsdPerMillion: 1, outputUsdPerMillion: 4, intelligence: 60 },
      { id: 'stub/contrast-small', inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.3, intelligence: 30 },
      { id: 'stub/contrast-medium', inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.6, intelligence: 40 },
    ],
  });
  log(`stub upstream at ${stub.baseUrl}`);
  const dht = new DHTNode({ peerId: '0'.repeat(40), port: 0, bootstrapNodes: [], reannounceIntervalMs: 15_000, operationTimeoutMs: 5_000 });
  await dht.start();
  const bootstrap = `127.0.0.1:${dht.getPort()}`;

  // ── Configs ──────────────────────────────────────────────────────────────────────────────
  const home = join(out, 'home');
  const pluginModules = join(home, '.antseed', 'plugins', 'node_modules', '@antseed');
  await mkdir(pluginModules, { recursive: true });
  for (const [name, path] of Object.entries(PLUGINS)) await symlink(path, join(pluginModules, name));
  const roundStorage = join(out, 'round-files');
  const env = {
    HOME: home,
    ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1',
    ANTSEED_ROUND_STORAGE_DIR: roundStorage,
    ANTSEED_BASE_RPC_URL: rpcUrl,
    STUB_UPSTREAM_KEY: 'stub',
    ANTSEED_KEYSTORE_PASSWORD: KEYSTORE_PASSWORD,
  };
  const crypto = { chainId: 'base-mainnet', rpcUrl, fallbackRpcUrls: [], verificationContractAddress: verification, verificationDeployBlock: deployBlock };
  for (const role of roles) {
    const node = nodes[role];
    node.buyerPort = await freePort();
    const config = {
      identity: { displayName: `kbf-e2e ${role}` },
      // Look for new sellers every 10s instead of every 5 minutes, so the run does not wait on discovery.
      buyer: { proxyPort: node.buyerPort, minPeerReputation: 0, peerRefreshIntervalMs: 10_000 },
      payments: { preferredMethod: 'crypto', crypto },
      network: { bootstrapNodes: [bootstrap] },
    };
    if (role.startsWith('seller')) {
      node.signalingPort = await freePort();
      node.dhtPort = await freePort();
      config.seller = {
        publicAddress: `127.0.0.1:${node.signalingPort}`,
        providers: {
          stub: {
            plugin: 'openai',
            baseUrl: stub.baseUrl,
            apiKeyEnv: 'STUB_UPSTREAM_KEY',
            services: {
              [MODEL]: {
                upstreamModel: role === 'seller-genuine' ? GENUINE_UPSTREAM : IMPOSTOR_UPSTREAM,
                categories: ['chat'],
                pricing: { inputUsdPerMillion: 0.5, outputUsdPerMillion: 2 },
              },
            },
          },
        },
      };
    }
    if (role === 'publisher' || role.startsWith('verifier')) {
      // The publisher builds banks from it; verifiers read reference prices from it to cap what
      // they pay (without it they would use OpenRouter's public catalog).
      config.verifier = {
        referenceEndpoint: { baseUrl: `${stub.baseUrl}/api/v1`, apiKeyEnv: 'STUB_UPSTREAM_KEY', sourceId: 'openrouter', trust: 'trusted' },
      };
    }
    await writeFile(node.configPath, JSON.stringify(config, null, 2));
  }
  const cli = (node, args) => [cliEntry, '--config', node.configPath, '--data-dir', node.dataDir, ...args];

  // ── Sellers: bind the agents, then serve ─────────────────────────────────────────────────
  for (const [role, agentId] of sellers) {
    run(process.execPath, cli(nodes[role], ['seller', 'register', '--agent-id', String(agentId)]), { env });
    const bound = Number(call(address('sellerRegistry'), 'getAgentId(address)(uint256)', [nodes[role].address]));
    check(bound === agentId, `${role} is registered as the seller of agent ${agentId}`);
    nodes[role].process = startProcess(role, process.execPath, cli(nodes[role], [
      'seller', 'start', '--dht-port', String(nodes[role].dhtPort), '--signaling-port', String(nodes[role].signalingPort),
      '--no-dashboard', '--min-settle-delta', '0.000001',
    ]), { ...env, ANTSEED_SETTLEMENT_IDLE_MS: '20000' });
  }

  // ── Publisher's buyer first, so the plan sees both sellers ──────────────────────────────
  const peersSeen = async (node) => {
    try {
      const state = JSON.parse(await readFile(join(node.dataDir, 'buyer.state.json'), 'utf8'));
      const peers = Array.isArray(state.discoveredPeers) ? state.discoveredPeers : [];
      const wanted = [nodes['seller-genuine'].address, nodes['seller-impostor'].address].map((value) => value.slice(2).toLowerCase());
      return wanted.every((peerId) => peers.some((peer) => String(peer.peerId).replace(/^0x/, '').toLowerCase() === peerId
        && peer.onChainAgentId && peer.onChainPoolPowerShareBps > 0));
    } catch {
      return false;
    }
  };
  startProcess('publisher-buyer', process.execPath, cli(nodes.publisher, ['buyer', 'start', '--port', String(nodes.publisher.buyerPort)]), env);
  await waitFor('the publisher\'s buyer discovered both staked sellers', () => peersSeen(nodes.publisher), 240_000);

  // ── Verifiers publish their encryption keys, then wait offline for the seed ─────────────
  const verifierRoles = ['verifier-1', 'verifier-2', 'verifier-3'];
  const startVerifier = (role, name = role) => {
    nodes[role].process = startProcess(name, process.execPath, cli(nodes[role], [
      'verifier', 'start', '--skip-version-check', '--interval', '10', '--buyer-port', String(nodes[role].buyerPort),
      '--keystore', nodes[role].keystore,
    ]), env);
  };
  for (const role of verifierRoles) startVerifier(role);
  await waitFor('every verifier published its encryption key', async () => {
    for (const role of verifierRoles) {
      if (isZeroHash(await client.encryptionKey(nodes[role].signer))) return false;
    }
    return true;
  }, 240_000);
  // Offline until the seed is fixed, so the run can pick the verifier to lose from the real plan.
  for (const role of verifierRoles) await stopProcess(nodes[role].process);

  const publisherProcess = startProcess('publisher', process.execPath, cli(nodes.publisher, [
    'verifier', 'publish', '--no-buyer', '--buyer-port', String(nodes.publisher.buyerPort), '--interval', '10',
    '--keystore', nodes.publisher.keystore,
  ]), env);

  // ── Seed: one where every verifier owns a slice, so the stopped one leaves work for backups ──
  const info = () => client.epochInfo(epoch);
  await waitFor('the publisher committed a sealed bank', async () => !isZeroHash((await info()).bankHash), 900_000, 5_000);
  await send(funder, verification, 'openEpoch(uint256)', [String(epoch)]);
  const members = (await client.epochVerifiers(epoch)).map((member) => member.toLowerCase());
  const targets = ['seller-genuine', 'seller-impostor'].map((role) => `${nodes[role].agentId}:${keccak256(toUtf8Bytes(MODEL)).toLowerCase()}`);
  const ownersFor = (seed) => {
    const owned = new Map(members.map((member) => [member, 0]));
    for (const key of targets) {
      for (let sliceIndex = 0; sliceIndex < SLICES_PER_SERVICE; sliceIndex++) {
        const owner = seededRanking(members, seed, `slice|${key}|${sliceIndex}`)[0];
        owned.set(owner, owned.get(owner) + 1);
      }
    }
    return owned;
  };
  let owned;
  for (let attempt = 1; ; attempt++) {
    const current = await info();
    const head = Number(BigInt(await rpc('eth_blockNumber')));
    if (head <= Number(current.seedBlock)) await rpc('anvil_mine', [`0x${(Number(current.seedBlock) - head + 1).toString(16)}`]);
    const blockHash = (await rpc('eth_getBlockByNumber', [`0x${current.seedBlock.toString(16)}`, false])).hash;
    const seed = keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32', 'uint256', 'bytes32'], [blockHash, epoch, current.bankHash]));
    owned = ownersFor(seed);
    if ([...owned.values()].every((count) => count > 0)) break;
    if (attempt === 8) throw new Error(`no seed in ${attempt} draws gave every verifier a slice`);
    // Let the seed block's hash expire: fixSeed then re-arms on a new future block.
    log(`seed draw ${attempt} leaves a verifier without slices (${JSON.stringify(Object.fromEntries(owned))}); redrawing`);
    await rpc('anvil_mine', ['0x102']);
    await send(funder, verification, 'fixSeed(uint256)', [String(epoch)]);
  }
  await send(funder, verification, 'fixSeed(uint256)', [String(epoch)]);
  check(!isZeroHash((await info()).seed), `seed fixed; slices per verifier ${JSON.stringify(Object.fromEntries(owned))}`);

  const stoppedRole = 'verifier-3';
  const liveRoles = verifierRoles.filter((role) => role !== stoppedRole);
  for (const role of liveRoles) startVerifier(role, `${role}-live`);
  log(`${stoppedRole} stays offline with ${owned.get(nodes[stoppedRole].signer.toLowerCase())} slices: they must go to backups`);

  // ── Collection ───────────────────────────────────────────────────────────────────────────
  await waitFor('the publisher committed the plan', async () => !isZeroHash((await info()).planHash), 300_000);
  await waitFor('the verifiers accepted the plan', async () => (await info()).planActive, 300_000);
  const storage = new DirectoryRoundStorage(roundStorage);
  const planEvent = (await client.planCommits(epoch)).at(-1);
  const plan = JSON.parse((await storage.get(planEvent.uri, planEvent.hash)).toString('utf8'));
  const collectors = Object.keys(plan.envelopes).sort();
  check(collectors.join() === [...members].sort().join(), `the plan seals slices to all ${collectors.length} verifiers, as the seed predicted`);
  check(Object.keys(plan.backupEnvelopes ?? {}).length > 0, 'the plan also seals the backed-up slices');
  // From here on the round must finish without the publisher: backups come from the plan, and
  // the bank key from the verifiers' escrowed shares.
  await stopProcess(publisherProcess);
  log('the publisher goes offline after the plan');
  const live = liveRoles.map((role) => nodes[role].signer);
  const liveBuyers = liveRoles.map((role) => nodes[role].address);
  await waitFor('both live verifiers committed their primary slices', async () => {
    for (const verifier of live) if (await client.sliceCommitCount(epoch, verifier) < 1) return false;
    return true;
  }, 900_000, 5_000);
  check(await client.sliceCommitCount(epoch, nodes[stoppedRole].signer) === 0, 'the stopped verifier committed nothing');

  let deadlines = kbfEpochDeadlines(await info(), await client.epochDuration());
  await warpTo(deadlines.commitDeadline + 5);
  // No publisher step here: each slice's backup verifier (second in its seeded ranking) finds the
  // owner's slices missing from the commitments and buys them from the plan's backup envelopes.
  const stopped = nodes[stoppedRole].signer.toLowerCase();
  const fixedSeed = (await info()).seed;
  const backupCollectors = [...new Set(targets.flatMap((key) => Array.from({ length: SLICES_PER_SERVICE }, (_, sliceIndex) => {
    const ranking = seededRanking(members, fixedSeed, `slice|${key}|${sliceIndex}`);
    return ranking[0] === stopped ? [ranking[1]] : [];
  }).flat()))];
  check(backupCollectors.length > 0 && backupCollectors.every((collector) => live.some((verifier) => verifier.toLowerCase() === collector)),
    `the stopped verifier's slices are backed up by live verifiers only (${backupCollectors.length})`);
  await waitFor('the backup verifiers committed the missing slices', async () => {
    const backups = (await client.sliceCommits(epoch)).filter((entry) => entry.backup).map((entry) => entry.sender.toLowerCase());
    return backupCollectors.every((collector) => backups.includes(collector));
  }, 900_000, 5_000);
  check(!(await client.sliceCommits(epoch)).some((entry) => entry.sender.toLowerCase() === stopped), 'the stopped verifier still committed nothing');

  // ── Reveal, attest, finalize, apply ──────────────────────────────────────────────────────
  // The verifiers give the publisher a few minutes to reveal the key, then post their shares.
  await warpTo(deadlines.backupDeadline + Math.min(600, Math.floor(ATTEST_WINDOW / 4)) + 5);
  await waitFor('the verifiers rebuilt and revealed the bank key from their shares', async () => !isZeroHash((await info()).bankKey), 300_000, 5_000);
  const shares = await client.keyShareReveals(epoch);
  check(shares.length >= 2 && shares.every((entry) => live.some((verifier) => verifier.toLowerCase() === entry.verifier.toLowerCase())),
    `the bank key came from ${shares.length} live verifiers' escrowed shares`);
  const roots = await waitFor('both live verifiers attested', async () => {
    const values = await Promise.all(live.map((verifier) => client.attestation(epoch, verifier)));
    return values.every((value) => !isZeroHash(value)) ? values : null;
  }, 600_000, 5_000);
  check(roots[0] === roots[1], `the live verifiers attested the same results root ${roots[0]}`);
  await waitFor('the epoch finalized on that root', async () => (await info()).finalizedRoot === roots[0], 120_000);

  const serviceHash = keccak256(toUtf8Bytes(MODEL));
  const verdictOf = async (agentId) => {
    const raw = run('cast', ['call', '--rpc-url', rpcUrl, verification, 'serviceStatus(uint256,bytes32)((bytes32,uint8,uint64,uint64))', String(agentId), serviceHash]);
    const [, verdict, , serviceEpoch] = raw.replace(/[()]/g, '').split(',').map((value) => value.trim().split(' ')[0]);
    return { verdict: Number(verdict), epoch: BigInt(serviceEpoch) };
  };
  const applied = async () => (await verdictOf(nodes['seller-genuine'].agentId)).epoch === epoch
    && (await verdictOf(nodes['seller-impostor'].agentId)).epoch === epoch;
  try {
    await waitFor('results applied by the first verifier in the apply ranking', applied, 120_000, 5_000);
  } catch {
    deadlines = kbfEpochDeadlines(await info(), await client.epochDuration());
    log('the stopped verifier was first to apply; moving past the fallback delay');
    await warpTo(deadlines.attestDeadline + APPLY_FALLBACK_DELAY + 5);
    await waitFor('results applied by a fallback verifier', applied, 180_000, 5_000);
  }
  const genuine = await verdictOf(nodes['seller-genuine'].agentId);
  const impostor = await verdictOf(nodes['seller-impostor'].agentId);
  check(genuine.verdict === 1, `genuine seller (agent ${nodes['seller-genuine'].agentId}) is SAME on-chain`);
  check(impostor.verdict === 2, `impostor seller (agent ${nodes['seller-impostor'].agentId}) is DIFF on-chain`);

  // ── Payments: channels the verifiers' buyers opened with each seller ────────────────────
  const channels = address('channels');
  const coder = AbiCoder.defaultAbiCoder();
  const reservedTopic = keccak256(toUtf8Bytes('Reserved(bytes32,address,address,uint128)'));
  const settledTopic = keccak256(toUtf8Bytes('ChannelSettled(bytes32,address,address,uint128,uint128,uint128,uint256,bytes)'));
  const logsFor = async (topic, seller) => rpc('eth_getLogs', [{
    address: channels, fromBlock: `0x${deployBlock.toString(16)}`, toBlock: 'latest',
    topics: [topic, null, null, coder.encode(['address'], [seller])],
  }]);
  const verifierChannels = {};
  for (const role of ['seller-genuine', 'seller-impostor']) {
    const reserved = await logsFor(reservedTopic, nodes[role].address);
    const fromVerifiers = reserved.filter((entry) => liveBuyers.some((buyer) => coder.decode(['address'], entry.topics[2])[0] === buyer));
    check(fromVerifiers.length >= 1, `${role} reserved ${fromVerifiers.length} payment channel(s) with the verifiers' buyers`);
    verifierChannels[role] = new Set(fromVerifiers.map((entry) => entry.topics[1]));
  }
  // Every seller must settle spending on a channel a live verifier's buyer reserved.
  for (const role of ['seller-genuine', 'seller-impostor']) {
    const settled = await waitFor(`${role} settled verifier spending on-chain`, async () => {
      const entries = (await logsFor(settledTopic, nodes[role].address)).filter((entry) => verifierChannels[role].has(entry.topics[1])
        && coder.decode(['uint128', 'uint128', 'uint128', 'uint256', 'bytes'], entry.data)[1] > 0n);
      return entries.length > 0 ? entries : null;
    }, 300_000, 10_000);
    const amount = settled.reduce((total, entry) => total + coder.decode(['uint128', 'uint128', 'uint128', 'uint256', 'bytes'], entry.data)[1], 0n);
    log(`${role}: ${settled.length} settlement(s) of verifier channels, ${Number(amount) / 1e6} USDC`);
  }

  // ── Rewards: claimed once the epoch is over ──────────────────────────────────────────────
  await warpTo(Number(await client.genesis()) + (Number(epoch) + 1) * (await client.epochDuration()) + 30);
  await waitFor('both live verifiers claimed their rewards', async () => {
    for (const verifier of live) if (!await client.rewardClaimed(epoch, verifier)) return false;
    return true;
  }, 300_000, 5_000);
  const ants = address('antsToken');
  for (const role of liveRoles) {
    const balance = BigInt(call(ants, 'balanceOf(address)(uint256)', [nodes[role].signer]));
    check(BigInt(call(ants, 'balanceOf(address)(uint256)', [nodes[role].address])) === 0n, `${role}'s buyer identity received no ANTS`);
    check(balance > 0n, `${role} received ${Number(balance / 10n ** 14n) / 1e4} ANTS`);
  }
  check(!await client.rewardClaimed(epoch, nodes[stoppedRole].signer), 'the stopped verifier earned nothing');
  log(`stub served ${[...stub.stats.completions.values()].reduce((a, b) => a + b, 0)} completions: ${JSON.stringify(Object.fromEntries(stub.stats.completions))}`);
  log(`PASS in ${((Date.now() - started) / 60_000).toFixed(1)} min`);
  await stub.close();
  await dht.stop();
}

async function cleanup(failed) {
  for (const { child } of [...children].reverse()) await stopProcess(child).catch(() => undefined);
  if (failed && out) {
    for (const { name, logFile } of children) {
      const text = await readFile(logFile, 'utf8').catch(() => '');
      console.error(`\n── last lines of ${name} ──\n${text.split('\n').slice(-25).join('\n')}`);
    }
  }
  if (out && !KEEP && !failed) await rm(out, { recursive: true, force: true });
  else if (out) console.log(`kept ${out}`);
}

main().then(() => cleanup(false)).catch(async (error) => {
  console.error(error instanceof Error ? error.stack : error);
  await cleanup(true);
  process.exit(1);
});

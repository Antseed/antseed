#!/usr/bin/env node
/**
 * End-to-end colony pool demo on a local chain:
 *   anvil + full protocol → AntseedColonyPool (staked seller façade)
 *   → seller node running the colony-pool provider
 *   → two workers serving a real local model through Ollama
 *   → buyer node: encrypted requests, buyer-signed per-worker attribution
 *   → each Mac owner links a payout wallet (the Mac's signed setPayout)
 *   → settlement through the pool → owners claim their USDC.
 *
 * Each component logs to its own file in DEMO_LOG_DIR (for side-by-side
 * viewing); the narration goes to stdout.
 *
 * Requires: anvil + forge on PATH, `ollama serve` with OLLAMA_MODEL pulled,
 * and a built workspace (`pnpm run build`).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, JsonRpcProvider, NonceManager, Wallet, formatUnits, getBytes, id, keccak256 } from 'ethers';

import { AntseedNode, ChannelsClient, loadOrCreateIdentity, toPeerId } from '@antseed/node';
import { ColonyPoolClient, parseWorkerPayoutLink } from '@antseed/node/payments';
import { DHTNode } from '@antseed/node/discovery';
import { WORKER_E2E_CAPABILITY, generateWorkerEncryptionKey } from '@antseed/node/worker-e2e';

const repoRoot = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
const pluginDist = join(repoRoot, 'plugins', 'provider-colony-pool', 'dist');
const { WorkerLedger, ColonyPool, ColonyPoolProvider } = await import(join(pluginDist, 'index.js'));
const { PoolWorker } = await import(join(pluginDist, 'worker.js'));
const { decodeWorkerTail } = await import(join(repoRoot, 'packages', 'protocol', 'dist', 'worker-attribution.js'));

const RPC_URL = 'http://127.0.0.1:8545';
const CHAIN_ID = 31337;
const DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const OLLAMA_URL = process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL ?? 'qwen2.5:0.5b';
/** Pass qwen3.5-2b when the Mac app joins with its default model. */
const SERVICE = process.env.DEMO_SERVICE ?? 'qwen2.5-0.5b';
const POOL_PORT = 8790;
const PAUSE_MS = Number(process.env.DEMO_PAUSE_MS ?? 1500);
/** Interface the chain and pool listen on: 0.0.0.0 lets a Mac on the LAN join. */
const BIND = process.env.DEMO_BIND ?? '127.0.0.1';
/** Workers this script runs itself; the rest are external (e.g. the Mac app on another machine). */
const LOCAL_WORKERS = Number(process.env.DEMO_LOCAL_WORKERS ?? 2);
const EXPECT_WORKERS = Number(process.env.DEMO_EXPECT_WORKERS ?? LOCAL_WORKERS);
/**
 * Video mode: the external Mac app's owner links and claims through the real
 * dashboards. Starts the ANTS dashboard for that owner's wallet and the seller
 * dashboard for the pool operator, and writes their URLs to DEMO_LOG_DIR.
 */
const VIDEO = process.env.DEMO_VIDEO === '1';
const BUYERS = [
  { name: 'alice', prompts: ['In one sentence: why do bees dance?', 'Write a haiku about a Mac earning money while its owner sleeps.'] },
  // A third request on one channel: its workers serve it only once bob's signed payments cover their earlier answers.
  { name: 'bob', prompts: ['In one sentence: what is end-to-end encryption?', 'Name three uses for idle computers, comma separated, no explanation.', 'In one word: is a sealed prompt readable by the pool?'] },
];

const logDir = process.env.DEMO_LOG_DIR ?? await mkdtemp(join(tmpdir(), 'colony-pool-demo-'));
await mkdir(logDir, { recursive: true });
const streams = new Map();
const stamp = () => new Date().toISOString().slice(11, 19);
function logTo(name, line) {
  if (!streams.has(name)) streams.set(name, createWriteStream(join(logDir, `${name}.log`), { flags: 'w' }));
  streams.get(name).write(`${stamp()} ${line}\n`);
}
const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', cyan: '\x1b[36m', yellow: '\x1b[33m', magenta: '\x1b[35m', reset: '\x1b[0m' };
async function step(title) {
  console.log(`\n${C.bold}${C.cyan}▸ ${title}${C.reset}`);
  await sleep(PAUSE_MS);
}
const say = (line) => console.log(`  ${line}`);
const short = (text, n = 72) => (text.length > n ? `${text.slice(0, n)}…` : text);
const usdc = (units) => `$${formatUnits(units, 6)}`;

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout + result.stderr;
}

async function waitFor(fn, label, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => null);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(intervalMs);
  }
}

/** A logging pass-through in front of Ollama: shows what each worker's local model receives. */
function startModelTap(name) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      tap(Buffer.concat(chunks), req, res).catch((err) => {
        // An Ollama failure answers this request instead of crashing the demo before its cleanup.
        logTo(name, `${C.yellow}[local model]${C.reset} upstream failed: ${err instanceof Error ? err.message : err}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'upstream_failed' }));
        else res.destroy();
      });
    });
  });
  async function tap(body, req, res) {
    const parsed = JSON.parse(body.toString());
    const prompt = parsed.messages?.at(-1)?.content ?? '';
    logTo(name, `${C.magenta}[local model]${C.reset} prompt in plaintext: "${short(String(prompt), 80)}"`);
    const upstream = await fetch(`${OLLAMA_URL}${req.url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    let text = '';
    for await (const chunk of upstream.body) {
      res.write(chunk);
      text += Buffer.from(chunk).toString();
    }
    res.end();
    const answer = text.includes('data:')
      ? text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)).choices?.[0]?.delta?.content ?? '').join('')
      : JSON.parse(text).choices?.[0]?.message?.content ?? '';
    logTo(name, `${C.magenta}[local model]${C.reset} answer: "${short(answer.replace(/\s+/g, ' '), 80)}"`);
  }
  return new Promise((resolveServer) => server.listen(0, '127.0.0.1', () => resolveServer(server)));
}

/** The link code the Mac app copies (PayoutAuthorization.swift): the worker key signs "pay my earnings to `payout`". */
async function payoutLinkCode(workerWallet, poolAddress, payout, nonce) {
  const deadline = Math.floor(Date.now() / 1000) + 3600;
  const digest = keccak256(AbiCoder.defaultAbiCoder().encode(
    ['bytes32', 'uint256', 'address', 'address', 'address', 'uint256', 'uint256'],
    [id('antseed-worker-payout/v1'), CHAIN_ID, poolAddress, workerWallet.address, payout, nonce, deadline],
  ));
  const signature = await workerWallet.signMessage(getBytes(digest));
  const json = JSON.stringify({ chainId: CHAIN_ID, pool: poolAddress, worker: workerWallet.address, payout, deadline, signature });
  return { code: `antseed-link:${Buffer.from(json).toString('base64url')}`, digest, deadline };
}

/** Video mode: the Mac owner's ANTS dashboard and the operator's seller dashboard, on the real servers. */
async function startVideoDashboards({ provider, A, poolAddress, sellerDir, sellerNode }) {
  const { createAntsServer } = await import(join(repoRoot, 'apps', 'ants', 'dist', 'server.js'));
  const { startSellerDashboard } = await import(join(repoRoot, 'apps', 'cli', 'dist', 'seller-monitor', 'dashboard-server.js'));
  const cliVersion = JSON.parse(await readFile(join(repoRoot, 'apps', 'cli', 'package.json'), 'utf8')).version;
  const owner = Wallet.createRandom().connect(provider);
  await provider.send('anvil_setBalance', [owner.address, '0xDE0B6B3A7640000']);
  writeFileSync(join(logDir, 'mac-owner.txt'), owner.address);
  const antsDir = await mkdtemp(join(tmpdir(), 'pool-ants-'));
  cleanup.push(() => rm(antsDir, { recursive: true, force: true }));
  const chain = {
    chainId: 'base-local', evmChainId: CHAIN_ID, rpcUrl: RPC_URL, fallbackRpcUrls: [],
    registryContractAddress: A.registry, depositsContractAddress: A.deposits, channelsContractAddress: A.channels, usdcContractAddress: A.usdc,
    identityRegistryAddress: A.identity, stakingContractAddress: A.staking, emissionsContractAddress: A.emissions, antsTokenAddress: A.ants,
    colonyPoolAddresses: [],
  };
  // Local signing stands in for the browser wallet's approval.
  const ants = await createAntsServer({ port: 3133, dataDir: antsDir, browserWallet: false, signer: owner, address: owner.address, chain, selectRpc: false });
  await ants.listen();
  cleanup.push(() => ants.close());
  writeFileSync(join(logDir, 'ants-url'), ants.url);

  // The seller dashboard reads the seller's data dir: daemon state, metering and the pool ledger.
  const startedAt = Date.now();
  const writeState = () => writeFileSync(join(sellerDir, 'daemon.state.json'), JSON.stringify({
    peerId: sellerNode.peerId, provider: 'colony-pool', startedAt, updatedAt: Date.now(), activeChannels: BUYERS.length, capacityUsedPercent: 12, notices: [],
  }));
  writeState();
  const stateTimer = setInterval(writeState, 2000);
  cleanup.push(() => clearInterval(stateTimer));
  writeFileSync(join(sellerDir, 'config.json'), JSON.stringify({ identity: { displayName: 'Demo Mac pool' } }));
  const seller = await startSellerDashboard({
    dataDir: sellerDir, configPath: join(sellerDir, 'config.json'), version: cliVersion, port: 3134,
    network: async () => ({ rows: [], source: 'demo' }), explorerUrl: async () => null,
  });
  cleanup.push(() => seller.close());
  writeFileSync(join(logDir, 'seller-url'), seller.url);
  return owner;
}

const cleanup = [];
async function main() {
  console.log(`${C.bold}Antseed colony pool — end-to-end demo${C.reset}`);
  console.log(`${C.dim}logs: ${logDir}${C.reset}`);

  // ── chain ──
  await step('Start a local chain and deploy the Antseed protocol');
  const provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, pollingInterval: 250 });
  // The demo deploys and mints on its chain: never on another one already listening there.
  if (await provider.getBlockNumber().then(() => true, () => false)) {
    throw new Error(`Something already answers on ${RPC_URL}; stop it (another anvil?) so the demo can start its own chain`);
  }
  const anvil = spawn('anvil', ['--host', BIND, '--port', '8545', '--chain-id', String(CHAIN_ID)], { stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup.push(() => anvil.kill('SIGTERM'));
  anvil.stdout.on('data', () => {});
  anvil.stderr.on('data', (chunk) => logTo('chain', chunk.toString().trimEnd()));
  // Deploy only while the anvil this demo started is alive: one that failed to start must not leave the demo to another chain.
  let anvilExit = null;
  const anvilEnded = new Promise((_, reject) => {
    anvil.once('error', (err) => { anvilExit = err; reject(new Error(`anvil could not start: ${err.message}`)); });
    anvil.once('exit', (code, signal) => { anvilExit = code ?? signal; reject(new Error(`anvil exited (${code ?? signal}) before the demo finished; see ${logDir}`)); });
  });
  anvilEnded.catch(() => {});
  await Promise.race([waitFor(() => provider.getBlockNumber().then(() => anvilExit === null), 'anvil'), anvilEnded]);
  const contractsDir = join(repoRoot, 'packages', 'contracts');
  const deployOut = run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', RPC_URL, '--broadcast', '--slow', '--skip', 'test'], contractsDir);
  const addr = (label) => deployOut.match(new RegExp(`${label}:\\s+(0x[0-9a-fA-F]{40})`))[1];
  const A = {
    usdc: addr('MockUSDC'), identity: addr('MockERC8004Registry'), ants: addr('ANTSToken'), registry: addr('AntseedRegistry'),
    staking: addr('AntseedStaking'), deposits: addr('AntseedDeposits'), channels: addr('AntseedChannels'), emissions: addr('AntseedEmissions'),
  };
  for (const [k, v] of Object.entries(A)) logTo('chain', `deployed ${k.padEnd(9)} ${v}`);
  say(`Channels ${A.channels}  ·  Deposits ${A.deposits}  ·  Staking ${A.staking}`);

  const deployerWallet = new Wallet(DEPLOYER_KEY, provider);
  const deployer = new NonceManager(deployerWallet);
  deployer.address = deployerWallet.address;
  const send = async (contract, method, ...args) => (await contract[method](...args)).wait();
  const erc20 = (a, signer = deployer) => new Contract(a, ['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'], signer);
  const usdcToken = erc20(A.usdc);

  // ── identities ──
  const sellerDir = await mkdtemp(join(tmpdir(), 'pool-seller-'));
  cleanup.push(() => rm(sellerDir, { recursive: true, force: true }));
  const sellerIdentity = await loadOrCreateIdentity(sellerDir);
  const operator = sellerIdentity.wallet.address;
  for (const buyer of BUYERS) {
    buyer.dir = await mkdtemp(join(tmpdir(), `pool-buyer-${buyer.name}-`));
    cleanup.push(() => rm(buyer.dir, { recursive: true, force: true }));
    buyer.identity = await loadOrCreateIdentity(buyer.dir);
    buyer.address = buyer.identity.wallet.address;
  }

  // ── pool contract ──
  await step('Deploy AntseedColonyPool — the on-chain seller that splits revenue between Macs');
  const poolOut = run('forge', ['create', 'staking/AntseedColonyPool.sol:AntseedColonyPool', '--rpc-url', RPC_URL, '--private-key', DEPLOYER_KEY, '--broadcast', '--skip', 'test', '--constructor-args', A.registry, operator], contractsDir);
  const poolAddress = poolOut.match(/Deployed to:\s+(0x[0-9a-fA-F]{40})/)[1];
  deployer.reset();
  logTo('chain', `deployed pool     ${poolAddress} (operator = seller node ${operator})`);
  say(`pool contract ${C.green}${poolAddress}${C.reset}  operator = seller node ${operator}`);

  // The pool owns its ERC-8004 agent (minted through the pool by its owner) and is staked like any seller façade.
  // On the seller-pool stack the owner would then call registerSeller(agentId) and stake ANTS for the agent;
  // this local stack still uses USDC staking.
  const poolAdmin = new Contract(poolAddress, ['function registerAgent(string) returns (uint256)', 'event AgentRegistered(uint256 indexed agentId)'], deployer);
  const registered = await send(poolAdmin, 'registerAgent', 'antseed:colony-pool-demo');
  const agentId = registered.logs.map((log) => { try { return poolAdmin.interface.parseLog(log); } catch { return null; } })
    .find((log) => log?.name === 'AgentRegistered').args.agentId;
  const STAKE = 10_000_000n;
  await send(usdcToken, 'mint', deployer.address, STAKE);
  await send(usdcToken, 'approve', A.staking, STAKE);
  const staking = new Contract(A.staking, ['function stakeFor(address,uint256,uint256)', 'function getStake(address) view returns (uint256)'], deployer);
  await send(staking, 'stakeFor', poolAddress, agentId, STAKE);
  const pool = new Contract(poolAddress, [
    'function setRemainderRecipient(address)', 'function usdcBalance(address) view returns (uint256)', 'function claimUsdc()',
    'function workerCumulative(bytes32,address) view returns (uint128)', 'function channelCumulative(bytes32) view returns (uint128)',
    'event UsdcCredited(address indexed account, bytes32 indexed channelId, uint256 indexed epoch, uint256 amount)',
  ], deployer);
  await send(pool, 'setRemainderRecipient', operator);
  say(`agent #${agentId} owned by the pool · staked ${usdc(await staking.getStake(poolAddress))} USDC`);

  // ── buyer funds ──
  await step('Fund two buyers: 5 USDC deposited for each');
  const DEPOSIT = 5_000_000n;
  const deposits = new Contract(A.deposits, ['function deposit(address,uint256)', 'function setCreditLimitOverride(address,uint256)', 'function getBuyerBalance(address) view returns (uint256,uint256,uint256)'], deployer);
  await provider.send('anvil_setBalance', [operator, '0xDE0B6B3A7640000']);
  for (const buyer of BUYERS) {
    await send(deposits, 'setCreditLimitOverride', buyer.address, 1_000_000_000n);
    await send(usdcToken, 'mint', deployer.address, DEPOSIT);
    await send(usdcToken, 'approve', A.deposits, DEPOSIT);
    await send(deposits, 'deposit', buyer.address, DEPOSIT);
    say(`${buyer.name.padEnd(5)} ${buyer.address} balance ${usdc((await deposits.getBuyerBalance(buyer.address))[0])}`);
    logTo('chain', `deposit ${usdc(DEPOSIT)} for buyer ${buyer.name} ${buyer.address}`);
  }

  // ── seller node + pool ──
  await step('Start the seller node with the colony-pool provider');
  const bootstrap = new DHTNode({ peerId: toPeerId('0'.repeat(40)), port: 0, bootstrapNodes: [], reannounceIntervalMs: 60_000, operationTimeoutMs: 5_000 });
  await bootstrap.start();
  cleanup.push(() => bootstrap.stop());
  const bootstrapNodes = [{ host: '127.0.0.1', port: bootstrap.getPort() }];
  const payments = (channelsAddress) => ({
    enabled: true, paymentMethod: 'crypto', rpcUrl: RPC_URL, chainId: CHAIN_ID, settlementIdleMs: 10 * 60_000,
    depositsAddress: A.deposits, channelsAddress, usdcAddress: A.usdc, identityRegistryAddress: A.identity, stakingAddress: A.staking,
  });
  const ledger = new WorkerLedger(join(sellerDir, 'colony-pool.db'));
  const PRICE = { inputUsdPerMillion: 20, outputUsdPerMillion: 80 };
  // DEMO_MODELS=service=repo@commit,… pins models (COLONY_POOL_MODELS); Antseed Colony offers them to pick from.
  const pins = new Map((process.env.DEMO_MODELS ?? '').split(',').filter(Boolean).map((entry) => {
    const at = entry.indexOf('=');
    return [entry.slice(0, at), entry.slice(at + 1)];
  }));
  const catalog = [...new Set([SERVICE, ...pins.keys()])];
  const colonyPool = new ColonyPool({
    // Workers are told the price, to check buyers' payments cover their answers at it.
    poolId: 'demo-pool', seller: poolAddress.toLowerCase(), catalog, prices: Object.fromEntries(catalog.map((service) => [service, PRICE])), workerShareBps: 9000, ledger,
    port: POOL_PORT, host: BIND, verifyOnJoin: true, log: (line) => logTo('pool', line),
    ...(pins.size ? { models: pins } : {}),
    // DEMO_ATTEST_INTERVAL_MS shortens re-attestation.
    ...(process.env.DEMO_ATTEST_INTERVAL_MS ? { attestationIntervalMs: Number(process.env.DEMO_ATTEST_INTERVAL_MS) } : {}),
  });
  const poolProvider = new ColonyPoolProvider({
    pool: colonyPool, ledger, workerShareBps: 9000, maxConcurrency: 16,
    pricing: { defaults: PRICE },
    serviceApiProtocols: { [SERVICE]: ['openai-chat-completions'] },
  });
  // Show exactly what the seller handles: ciphertext in, ciphertext out.
  for (const method of ['handleRequest', 'handleRequestStream']) {
    const original = poolProvider[method].bind(poolProvider);
    poolProvider[method] = async (req, callbacks) => {
      const outer = JSON.parse(new TextDecoder().decode(req.body));
      if (outer.antseed_e2e) {
        const recipients = outer.antseed_e2e.recipients.map((r) => `${r.worker.slice(0, 10)}…`).join(', ');
        logTo('pool', `${C.yellow}request ${req.requestId.slice(0, 8)}${C.reset} → sealed for ${recipients} (tried in rank order) model=${outer.model}`);
        logTo('pool', `  ${C.dim}body the pool sees: ct=${outer.antseed_e2e.ct.slice(0, 48)}…${C.reset}`);
      }
      const response = await original(req, callbacks);
      const text = new TextDecoder().decode(response.body);
      const ct = text.match(/"ct":"([^"]{1,48})/)?.[1];
      if (ct) logTo('pool', `  ${C.dim}answer the pool sees: ct=${ct}…  (usage in clear for billing)${C.reset}`);
      return response;
    };
  }
  await colonyPool.start();
  cleanup.push(() => colonyPool.stop());
  const sellerNode = new AntseedNode({
    role: 'seller', dataDir: sellerDir, identity: sellerIdentity, dhtPort: 0, signalingPort: 0, bootstrapNodes, allowPrivateIPs: true,
    sellerContract: { sellerContract: poolAddress }, payments: payments(poolAddress),
  });
  sellerNode.registerProvider(poolProvider);
  await sellerNode.start();
  cleanup.push(() => sellerNode.stop());
  logTo('pool', `seller node ${sellerNode.peerId} up; workers connect to ws://127.0.0.1:${POOL_PORT}`);
  let macOwner = null;
  if (VIDEO) macOwner = await startVideoDashboards({ provider, A, poolAddress, sellerDir, sellerNode });
  say(`seller peer ${sellerNode.peerId.slice(0, 16)}… announces capability ${WORKER_E2E_CAPABILITY}`);

  // ── workers ──
  await step(EXPECT_WORKERS > LOCAL_WORKERS
    ? 'Macs join the pool: one local worker, plus Antseed Colony on another Mac (TensorFold)'
    : 'Two Macs join the pool (each with its own key and a local model)');
  const workers = [];
  for (const name of ['worker-a', 'worker-b'].slice(0, LOCAL_WORKERS)) {
    const tap = await startModelTap(name);
    cleanup.push(() => tap.close());
    const wallet = Wallet.createRandom();
    const worker = new PoolWorker({
      poolUrl: `ws://127.0.0.1:${POOL_PORT}`,
      baseUrl: `http://127.0.0.1:${tap.address().port}`,
      services: { [SERVICE]: OLLAMA_MODEL },
      privateKey: wallet.privateKey,
      encryptionKey: generateWorkerEncryptionKey(),
      agent: `antseed-mac/${name}`,
      channelVerifier: async (channel, buyer, seller) => {
        // The deployed Channels contract, never one the pool names.
        const session = await new ChannelsClient({ rpcUrl: RPC_URL, contractAddress: A.channels, evmChainId: CHAIN_ID }).getSession(channel);
        if (/^0x0+$/.test(session.buyer)) return null;
        // Only an Active channel (status 1) pays for work; a closed one keeps its buyer and seller.
        const ok = session.status === 1 && session.buyer.toLowerCase() === buyer.toLowerCase() && session.seller.toLowerCase() === seller.toLowerCase();
        logTo(name, `${ok ? C.green : C.yellow}on-chain check${C.reset}: channel ${channel.slice(0, 12)}… buyer=${session.buyer.slice(0, 10)}… seller=pool → ${ok ? 'genuine buyer' : 'MISMATCH'}`);
        // Its reserve bounds what the buyer's payments for this worker's answers can redeem.
        return ok ? { deposit: session.deposit } : false;
      },
      // Buyers sign SpendingAuths for this contract; the worker checks they pay for its earlier answers.
      channelsDomain: { chainId: CHAIN_ID, channelsAddress: A.channels },
      log: (line) => logTo(name, line),
    });
    worker.start();
    cleanup.push(() => worker.stop());
    workers.push({ name, wallet, worker });
    logTo(name, `worker address (payout) ${wallet.address}`);
    say(`${name}: ${wallet.address}`);
  }
  if (EXPECT_WORKERS > LOCAL_WORKERS) say(`waiting for the Mac app to join ws://<this Mac>:${POOL_PORT}…`);
  await waitFor(async () => poolProvider.services.includes(SERVICE) && colonyPool.workerSummaries().filter((w) => w.services.length).length >= EXPECT_WORKERS, 'workers verified', Number(process.env.DEMO_WORKER_WAIT_MS ?? 300_000), 500);
  for (const summary of colonyPool.workerSummaries()) {
    if (workers.some((w) => w.wallet.address.toLowerCase() === summary.address)) continue;
    workers.push({ name: 'mac-app', wallet: { address: summary.address }, external: true, agent: summary.agent });
    say(`mac-app: ${summary.address}  ${C.dim}(${summary.agent} · ${summary.attested ? 'attested hardened Mac' : 'not attested as hardened'})${C.reset}`);
  }
  say(`${C.green}all ${workers.length} workers passed the encrypted join check${C.reset} → seller now announces ${SERVICE}`);

  // ── payout wallets ──
  await step("Each Mac's owner links the wallet its earnings go to (Rewards → Link a Mac)");
  const poolClient = new ColonyPoolClient({ rpcUrl: RPC_URL, contractAddress: poolAddress, evmChainId: CHAIN_ID });
  const poolReader = new Contract(poolAddress, ['function payoutNonce(address) view returns (uint256)', 'function payoutDigest(address,address,uint256) view returns (bytes32)'], provider);
  for (const w of workers) {
    if (w.external && macOwner) {
      say(`${w.name.padEnd(9)} the app signs a link for ${macOwner.address}; its owner pastes it in Rewards → Link a Mac…`);
      await waitFor(async () => (await poolClient.payoutOf(w.wallet.address)).toLowerCase() === macOwner.address.toLowerCase(), 'the Mac owner to link', 600_000, 500);
      w.owner = macOwner;
      logTo('chain', `setPayout mac-app → owner ${macOwner.address} (submitted from the ANTS dashboard)`);
      say(`${w.name.padEnd(9)} pays to owner ${C.green}${macOwner.address}${C.reset}  ${C.dim}(linked in the ANTS dashboard)${C.reset}`);
      continue;
    }
    if (w.external) {
      // The app's own Link button signs this; until its owner pastes the code, credits stay with the Mac's key.
      say(`${w.name.padEnd(9)} not linked here ${C.dim}(press Link in the app, then paste the code in Rewards)${C.reset}`);
      continue;
    }
    w.owner = Wallet.createRandom().connect(provider);
    await provider.send('anvil_setBalance', [w.owner.address, '0xDE0B6B3A7640000']);
    const { code, digest, deadline } = await payoutLinkCode(w.wallet, poolAddress, w.owner.address, await poolReader.payoutNonce(w.wallet.address));
    if (digest !== await poolReader.payoutDigest(w.wallet.address, w.owner.address, deadline)) throw new Error('payout digest differs from the contract');
    // What the ANTS dashboard does with the pasted code: parse it, then submit from the owner's wallet.
    const authorization = parseWorkerPayoutLink(code);
    const hash = await poolClient.setPayout(w.owner, authorization);
    logTo('chain', `setPayout ${w.name} → owner ${w.owner.address} (tx ${hash.slice(0, 12)}…)`);
    logTo(w.name, `earnings now pay to owner wallet ${w.owner.address}`);
    say(`${w.name.padEnd(9)} pays to owner ${C.green}${w.owner.address}${C.reset}  ${C.dim}(${short(code, 40)})${C.reset}`);
    if ((await poolClient.payoutOf(w.wallet.address)).toLowerCase() !== w.owner.address.toLowerCase()) throw new Error('payout not set');
  }

  // ── buyers ──
  const enc = new TextEncoder();
  const nameOf = (w) => {
    const owner = workers.find((x) => x.owner?.address.toLowerCase() === w.toLowerCase());
    return owner ? `${owner.name} owner` : workers.find((x) => x.wallet.address.toLowerCase() === w.toLowerCase())?.name ?? w;
  };
  for (const buyer of BUYERS) {
    await step(`Buyer ${buyer.name} discovers the seller on the DHT and gets its top-ranked Macs assigned`);
    buyer.node = new AntseedNode({ role: 'buyer', dataDir: buyer.dir, identity: buyer.identity, dhtPort: 0, bootstrapNodes, allowPrivateIPs: true, payments: payments(A.channels) });
    await buyer.node.start();
    cleanup.push(() => buyer.node.stop());
    buyer.peer = await waitFor(async () => {
      await sellerNode._announcer?.announce?.().catch(() => undefined);
      const peers = await buyer.node.discoverPeers(SERVICE);
      return peers.find((p) => p.peerId === sellerNode.peerId && (p.capabilities ?? []).includes(WORKER_E2E_CAPABILITY));
    }, 'seller discovery', 60_000, 1000);
    say(`found ${buyer.peer.peerId.slice(0, 16)}… · seller contract 0x${buyer.peer.metadata?.sellerContract} · capability ${WORKER_E2E_CAPABILITY}`);

    for (const [i, prompt] of buyer.prompts.entries()) {
      const stream = i === 1;
      const request = {
        requestId: `${buyer.name}-${i + 1}-${Date.now().toString(36)}`, method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: enc.encode(JSON.stringify({ model: SERVICE, stream, max_tokens: 60, messages: [{ role: 'user', content: prompt }] })),
      };
      console.log(`\n  ${C.bold}${buyer.name}:${C.reset} ${prompt}`);
      process.stdout.write(`  ${C.bold}${C.green}model:${C.reset} `);
      if (stream) {
        let buffered = '';
        await buyer.node.sendRequestStream(buyer.peer, request, {
          onResponseChunk: (chunk) => {
            buffered += new TextDecoder().decode(chunk.data);
            const events = buffered.split('\n\n');
            buffered = events.pop() ?? '';
            for (const event of events) {
              const data = event.replace(/^data: /, '');
              if (!data.startsWith('{')) continue;
              const delta = JSON.parse(data).choices?.[0]?.delta?.content;
              if (delta) process.stdout.write(delta.replace(/\n/g, ' '));
            }
          },
        });
        console.log(`  ${C.dim}(streamed, decrypted by the buyer)${C.reset}`);
      } else {
        const response = await buyer.node.sendRequest(buyer.peer, request);
        const text = JSON.parse(new TextDecoder().decode(response.body)).choices?.[0]?.message?.content ?? `(HTTP ${response.statusCode})`;
        console.log(`${text.replace(/\s+/g, ' ').trim()}  ${C.dim}(decrypted by the buyer)${C.reset}`);
      }
      await sleep(PAUSE_MS / 2);
    }
    buyer.channelId = buyer.node.buyerPaymentManager.getActiveSession(sellerNode.peerId).sessionId;
  }

  // ── attribution ──
  await step('What each buyer signed: per-worker totals inside its SpendingAuth metadata');
  for (const buyer of BUYERS) {
    const latest = await waitFor(async () => sellerNode._sellerPaymentManager?._latestAuth?.get?.(buyer.channelId) ?? null, 'latest auth', 10_000);
    buyer.signed = latest.cumulativeAmount;
    say(`${buyer.name.padEnd(5)} channel ${buyer.channelId.slice(0, 14)}…  signed ${usdc(latest.cumulativeAmount)}`);
    for (const entry of decodeWorkerTail(latest.metadata) ?? []) {
      say(`      ↳ ${nameOf(entry.worker).padEnd(9)} ${entry.worker}  ${usdc(entry.cumulativeAmount)}`);
    }
  }

  // ── settlement ──
  await step('The seller settles both channels through the pool contract, which splits the payout');
  const operatorBefore = await usdcToken.balanceOf(operator);
  const fromBlock = await provider.getBlockNumber();
  for (const buyer of BUYERS) await sellerNode._sellerPaymentManager.settleSession(buyer.node.peerId, { settleOnly: true });
  const credits = await waitFor(async () => {
    const events = await pool.queryFilter(pool.filters.UsdcCredited(), fromBlock + 1);
    return events.length >= 2 ? events : null;
  }, 'pool credits', 30_000, 500);
  for (const event of credits) {
    const who = event.args.account.toLowerCase() === operator.toLowerCase() ? 'remainder' : nameOf(event.args.account);
    logTo('chain', `${C.green}UsdcCredited${C.reset} ${who} ${usdc(event.args.amount)} (channel ${event.args.channelId.slice(0, 12)}…, tx ${event.transactionHash.slice(0, 12)}…)`);
  }
  const gross = BUYERS.reduce((sum, b) => sum + b.signed, 0n);
  const operatorFee = (await usdcToken.balanceOf(operator)) - operatorBefore;
  // Read the credits from the contract's events: a worker may claim before we look at its balance.
  const creditOf = (address) => credits
    .filter((e) => e.args.account.toLowerCase() === address.toLowerCase())
    .reduce((sum, e) => sum + e.args.amount, 0n);
  const credited = credits.reduce((sum, e) => sum + e.args.amount, 0n);
  say(`buyers paid             ${usdc(gross)}`);
  say(`protocol fee (Channels) ${usdc(gross - operatorFee - credited)}`);
  say(`operator fee (10%)      ${usdc(operatorFee)} → operator wallet`);
  const payee = (w) => w.owner?.address ?? w.wallet.address;
  for (const w of workers) say(`${w.name.padEnd(9)} credited ${C.green}${usdc(creditOf(payee(w)))}${C.reset}${w.owner ? `  ${C.dim}→ owner wallet${C.reset}` : ''}`);
  const remainder = creditOf(operator);
  if (remainder > 0n) say(`remainder credited ${usdc(remainder)} (rounding)`);

  await step('Owners claim their Macs\' USDC from the pool (Rewards → Claim to wallet)');
  for (const w of workers) {
    if (!w.owner) {
      say(`${w.name.padEnd(9)} ${usdc(await pool.usdcBalance(w.wallet.address))} held for the Mac until its owner links a wallet`);
      continue;
    }
    if (w.external) {
      // Ranked routing may send every request to another worker: then there is nothing to claim.
      if (creditOf(w.owner.address) === 0n && (await pool.usdcBalance(w.owner.address)) === 0n) {
        say(`${w.name.padEnd(9)} served no paid requests this run (the pool routed them to higher-ranked workers): nothing to claim`);
        continue;
      }
      say(`${w.name.padEnd(9)} owner claims in the ANTS dashboard (Rewards → Claim to wallet)…`);
      const after = await waitFor(async () => {
        const [owed, balance] = await Promise.all([pool.usdcBalance(w.owner.address), usdcToken.balanceOf(w.owner.address)]);
        return owed === 0n && balance > 0n ? balance : null;
      }, 'the Mac owner to claim', 600_000, 500);
      say(`${w.name.padEnd(9)} owner wallet USDC $0.0 → ${C.green}${usdc(after)}${C.reset}  ${C.dim}(claimed in the ANTS dashboard)${C.reset}`);
      continue;
    }
    const before = await usdcToken.balanceOf(w.owner.address);
    if ((await poolClient.usdcBalance(w.owner.address)) > 0n) {
      const hash = await poolClient.claimUsdc(w.owner);
      logTo('chain', `claimUsdc by ${w.name} owner (tx ${hash.slice(0, 12)}…)`);
    }
    const after = await usdcToken.balanceOf(w.owner.address);
    say(`${w.name.padEnd(9)} owner wallet USDC ${usdc(before)} → ${C.green}${usdc(after)}${C.reset}`);
    logTo(w.name, `${C.green}owner claimed ${usdc(after - before)} USDC from the pool contract${C.reset}`);
  }

  console.log(`\n${C.bold}${C.green}✓ Done:${C.reset} encrypted requests, buyer-signed attribution, payout links, on-chain split, owner claims.`);
  await sleep(Number(process.env.DEMO_HOLD_MS ?? 3000));
}

main()
  .catch((err) => {
    console.error(`\n${C.yellow}demo failed:${C.reset}`, err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const fn of cleanup.reverse()) await Promise.resolve().then(fn).catch(() => {});
    for (const s of streams.values()) s.end();
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  });

#!/usr/bin/env node

import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  ANVIL_ACCOUNT_0,
  ANVIL_ACCOUNT_1,
  BASE_MAINNET_DIEM_PROXY,
  BASE_MAINNET_DIEM_STAKER,
  BASE_MAINNET_FORK_BLOCK,
  deployForkVerifierStub,
  migration,
  prepareForkOwners,
  prepareForkStaker,
} from './deployments/m001.mjs';
import { withAnvilFork, advanceTimeTo, impersonatedSend } from './deployments/runtime/anvil.mjs';
import { call, cast, firstValue } from './deployments/runtime/chain.mjs';
import { loadContext } from './deployments/runtime/ledger.mjs';
import { runMigration } from './deployments/runtime/runner.mjs';
import { writeJsonAtomic } from './deployments/runtime/artifacts.mjs';
import { loadDotEnv } from './deployments/runtime/env.mjs';
import { renderNetwork } from './generate-contract-chain-config.mjs';

const DEFAULT_OUT = '.m001-sandbox';
const DEFAULT_PORT = 8545;
const STATE_FILE = 'sandbox.json';
const CLI_CONFIG_FILE = 'cli-config.json';
const WEEK_SECONDS = 7 * 24 * 60 * 60;

function usage() {
  console.log(`Usage: pnpm m001:sandbox <command> [args] [--port <port>] [--out <dir>]

Commands:
  up
  cutover
  advance-epoch [n]
  fund-seller <address>
  fund-ants <address> <amount>
  fund-position-init <n>
  status
  down`);
}

export function parseSandboxArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  let port = DEFAULT_PORT;
  let out = DEFAULT_OUT;
  const positional = [];
  while (args.length) {
    const arg = args.shift();
    if (arg === '--port') port = Number(args.shift());
    else if (arg === '--out') out = args.shift();
    else positional.push(arg);
  }
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('--port must be a valid TCP port');
  return { command, port, out: path.resolve(out), positional };
}

function statePath(out) { return path.join(out, STATE_FILE); }
function cliConfigPath(out) { return path.join(out, CLI_CONFIG_FILE); }

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

async function readState(out) {
  try { return await readJson(statePath(out)); }
  catch { throw new Error(`M001 sandbox is not running at ${out}. Run 'pnpm m001:sandbox up' first.`); }
}

function processIsRunning(pid) {
  try { process.kill(pid, 0); return true; }
  catch { return false; }
}

function forkEnvironment(verifier) {
  return {
    SP1_VERIFIER: verifier,
    SP1_VERIFIER_HASH: process.env.SP1_VERIFIER ? process.env.SP1_VERIFIER_HASH : `0x${'0'.repeat(63)}1`,
    WASH_TRADING_SELLER_PROGRAM_VKEY: process.env.WASH_TRADING_SELLER_PROGRAM_VKEY ?? `0x${'0'.repeat(63)}1`,
    HISTORICAL_PERIOD_START_BLOCK: process.env.HISTORICAL_PERIOD_START_BLOCK ?? '1',
    HISTORICAL_PERIOD_END_BLOCK: process.env.HISTORICAL_PERIOD_END_BLOCK ?? String(BASE_MAINNET_FORK_BLOCK),
    VERIFICATION_WALLET: ANVIL_ACCOUNT_1,
    DIEM_STAKING_PROXY: BASE_MAINNET_DIEM_PROXY,
    ANTSEED_DEPLOY_CONFIRM: 'base-mainnet',
  };
}

function forkSigners() {
  return {
    deployer: `unlocked:${ANVIL_ACCOUNT_0}`,
    registryOwner: `unlocked:${ANVIL_ACCOUNT_0}`,
    channelsOwner: `unlocked:${ANVIL_ACCOUNT_1}`,
    sellerRewardsPoolOwner: `unlocked:${ANVIL_ACCOUNT_1}`,
    diemStaker: `unlocked:${BASE_MAINNET_DIEM_STAKER}`,
  };
}

async function writeCliConfig(out, rpcUrl) {
  const record = await readJson(path.join(out, 'base-mainnet', 'current.json'));
  const generated = renderNetwork(record);
  const crypto = { chainId: 'base-mainnet', rpcUrl, fallbackRpcUrls: [] };
  for (const [key, value] of Object.entries(generated)) {
    if (key.endsWith('Address')) crypto[key] = value;
  }
  await writeJsonAtomic(cliConfigPath(out), { payments: { crypto } });
}

async function up(options) {
  const forkUrl = process.env.BASE_MAINNET_RPC_URL;
  if (!forkUrl) throw new Error('BASE_MAINNET_RPC_URL is required');
  await mkdir(options.out, { recursive: true });
  try {
    const existing = await readJson(statePath(options.out));
    if (processIsRunning(existing.pid)) throw new Error(`Sandbox already running at ${existing.rpcUrl} (pid ${existing.pid})`);
  } catch (error) {
    if ((error).message?.startsWith('Sandbox already')) throw error;
  }

  await withAnvilFork({
    forkUrl,
    forkBlockNumber: BASE_MAINNET_FORK_BLOCK,
    chainId: 8453,
    port: options.port,
    keepAlive: true,
  }, async ({ rpcUrl, child }) => {
    try {
      const context = await loadContext(migration, 'base-mainnet', { rpcUrl, outputRoot: options.out, forkTest: true });
      prepareForkOwners(context);
      const verifier = process.env.SP1_VERIFIER ?? deployForkVerifierStub(rpcUrl);
      const overrides = {
        rpcUrl,
        outputRoot: options.out,
        forkTest: true,
        environment: forkEnvironment(verifier),
        signers: forkSigners(),
      };
      const observation = await runMigration(migration, { network: 'base-mainnet', mode: 'broadcast', signers: {} }, overrides);
      if (observation.state !== 'awaiting-epoch') throw new Error(`Expected awaiting-epoch after deploy, got ${observation.state}`);
      await writeCliConfig(options.out, rpcUrl);
      await writeJsonAtomic(statePath(options.out), {
        pid: child.pid,
        rpcUrl,
        port: options.port,
        outputRoot: options.out,
        verifier,
        cutoverTimestamp: observation.deployment.checkpoint.cutoverTimestamp,
        startedAt: new Date().toISOString(),
      });
      console.log(`M001 sandbox deployed (pre-cutover): ${rpcUrl}`);
      console.log(`CLI config: ${cliConfigPath(options.out)}`);
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }
  });
}

async function cutover(options) {
  const state = await readState(options.out);
  if (!processIsRunning(state.pid)) throw new Error(`Anvil process ${state.pid} is not running`);
  advanceTimeTo(state.rpcUrl, state.cutoverTimestamp + 1);
  const context = await loadContext(migration, 'base-mainnet', { rpcUrl: state.rpcUrl, outputRoot: options.out, forkTest: true });
  prepareForkStaker(context);
  const observation = await runMigration(
    migration,
    { network: 'base-mainnet', mode: 'broadcast', signers: {} },
    {
      rpcUrl: state.rpcUrl,
      outputRoot: options.out,
      forkTest: true,
      environment: forkEnvironment(state.verifier),
      signers: forkSigners(),
    },
  );
  if (observation.state !== 'active') throw new Error(`Expected active after cutover, got ${observation.state}`);
  await writeCliConfig(options.out, state.rpcUrl);
  console.log(`M001 cutover complete. CLI config refreshed: ${cliConfigPath(options.out)}`);
}

async function advanceEpoch(options) {
  const state = await readState(options.out);
  const count = Number(options.positional[0] ?? 1);
  if (!Number.isInteger(count) || count <= 0) throw new Error('advance-epoch count must be a positive integer');
  const latest = JSON.parse(cast(state.rpcUrl, ['block', 'latest', '--json']));
  const timestamp = Number(BigInt(latest.timestamp));
  advanceTimeTo(state.rpcUrl, timestamp + count * WEEK_SECONDS);
  console.log(`Advanced ${count} epoch(s).`);
}

function requireAddress(value, label) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value ?? '')) throw new Error(`${label} must be an EVM address`);
  return value;
}

function parseAntsAmount(value) {
  const match = value?.match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) throw new Error('ANTS amount must be a positive number with at most 18 decimals');
  const amount = BigInt(match[1]) * 10n ** 18n + BigInt((match[2] ?? '').padEnd(18, '0') || '0');
  if (amount <= 0n) throw new Error('ANTS amount must be positive');
  return amount;
}

async function currentContracts(out) {
  return (await readJson(path.join(out, 'base-mainnet', 'current.json'))).contracts;
}

async function fundSeller(options) {
  const state = await readState(options.out);
  const recipient = requireAddress(options.positional[0], 'seller address');
  const contracts = await currentContracts(options.out);
  const holder = contracts.legacyStaking?.address ?? contracts.staking.address;
  impersonatedSend(state.rpcUrl, holder, contracts.usdc.address, 'transfer(address,uint256)', [recipient, '50000000']);
  cast(state.rpcUrl, ['rpc', 'anvil_setBalance', recipient, '0xDE0B6B3A7640000']);
  console.log(`Funded ${recipient} with 50 USDC and 1 ETH.`);
}

function fundAntsFromHolder(rpcUrl, token, holder, recipient, amount) {
  const owner = call(rpcUrl, token, 'owner()(address)');
  impersonatedSend(rpcUrl, owner, token, 'setTransferWhitelist(address,bool)', [holder, 'true']);
  try {
    impersonatedSend(rpcUrl, holder, token, 'transfer(address,uint256)', [recipient, String(amount)]);
  } finally {
    impersonatedSend(rpcUrl, owner, token, 'setTransferWhitelist(address,bool)', [holder, 'false']);
  }
}

async function fundAnts(options) {
  const state = await readState(options.out);
  const recipient = requireAddress(options.positional[0], 'recipient address');
  const amountText = options.positional[1];
  if (!amountText) throw new Error('fund-ants requires an amount');
  const amount = parseAntsAmount(amountText);
  const holder = requireAddress(process.env.ANTS_HOLDER, 'ANTS_HOLDER');
  const contracts = await currentContracts(options.out);
  fundAntsFromHolder(state.rpcUrl, contracts.antsToken.address, holder, recipient, amount);
  const owner = call(state.rpcUrl, contracts.antsToken.address, 'owner()(address)');
  impersonatedSend(state.rpcUrl, owner, contracts.antsToken.address, 'setTransferWhitelist(address,bool)', [recipient, 'true']);
  console.log(`Funded ${recipient} with ${amountText} ANTS.`);
}

async function fundPositionInit(options) {
  const state = await readState(options.out);
  const count = Number(options.positional[0]);
  if (!Number.isInteger(count) || count <= 0) throw new Error('fund-position-init requires a positive integer');
  const holder = requireAddress(process.env.ANTS_HOLDER, 'ANTS_HOLDER');
  const contracts = await currentContracts(options.out);
  if (!contracts.positionInit) throw new Error('positionInit is not active; run cutover first');
  const initAmount = BigInt(firstValue(call(state.rpcUrl, contracts.positionInit.address, 'initAmount()(uint256)')));
  fundAntsFromHolder(state.rpcUrl, contracts.antsToken.address, holder, contracts.positionInit.address, initAmount * BigInt(count));
  console.log(`Funded PositionInit for ${count} starter position(s).`);
}

async function status(options) {
  const state = await readState(options.out);
  const contracts = await currentContracts(options.out);
  const registry = contracts.registry.address;
  console.log(`RPC: ${state.rpcUrl}`);
  console.log(`PID: ${state.pid} (${processIsRunning(state.pid) ? 'running' : 'stopped'})`);
  console.log(`Release: ${(await readJson(path.join(options.out, 'base-mainnet', 'current.json'))).release}`);
  console.log(`Registry emissions: ${call(state.rpcUrl, registry, 'emissions()(address)')}`);
  console.log(`Registry staking: ${call(state.rpcUrl, registry, 'staking()(address)')}`);
}

async function down(options) {
  const state = await readState(options.out);
  if (processIsRunning(state.pid)) process.kill(state.pid, 'SIGTERM');
  await rm(statePath(options.out), { force: true });
  console.log(`Stopped M001 sandbox on ${state.rpcUrl}.`);
}

export async function runSandbox(options) {
  await loadDotEnv();
  switch (options.command) {
    case 'up': return up(options);
    case 'cutover': return cutover(options);
    case 'advance-epoch': return advanceEpoch(options);
    case 'fund-seller': return fundSeller(options);
    case 'fund-ants': return fundAnts(options);
    case 'fund-position-init': return fundPositionInit(options);
    case 'status': return status(options);
    case 'down': return down(options);
    default: usage(); throw new Error(`Unknown or missing command: ${options.command ?? '(none)'}`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSandbox(parseSandboxArgs(process.argv.slice(2))).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

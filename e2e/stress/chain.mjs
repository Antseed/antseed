// Local anvil chain: deploy the repo's real contracts with Deploy.s.sol and
// replicate scripts/setup-local-test.sh (fund, mint, register, stake,
// setOperator, deposit). The post-setup state is dumped once per output
// directory and loaded into a fresh anvil for every run.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { getChainConfig } from '../../packages/node/dist/payments/chain-config.js';

export const KEYS = {
  deployer: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  seller: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  buyer: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
};
export const ADDR = {
  deployer: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  seller: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  buyer: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
};
// Deploy.s.sol's deterministic addresses on a fresh chain: the base-local preset.
const local = getChainConfig('base-local');
export const C = {
  usdc: local.usdcContractAddress,
  identity: local.identityRegistryAddress,
  registry: local.registryContractAddress,
  staking: local.stakingContractAddress,
  deposits: local.depositsContractAddress,
  channels: local.channelsContractAddress,
  emissions: local.emissionsContractAddress,
  depositRelay: local.depositRelayAddress,
};
export const BUYER_DEPOSIT = 500_000_000n; // 500 USDC

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 6).join(' ')} failed: ${r.stdout}\n${r.stderr}`);
  return r.stdout.trim();
}
export function cast(rpc, args) { return run('cast', [...args, '--rpc-url', rpc]); }
function send(rpc, key, ...args) { return cast(rpc, ['send', '--private-key', key, ...args]); }
export function call(rpc, ...args) { return cast(rpc, ['call', ...args]); }

export async function startAnvil(port, blockTime) {
  const args = ['--port', String(port), '--host', '127.0.0.1', '--chain-id', '31337', '--silent'];
  if (blockTime) args.push('--block-time', String(blockTime));
  // Its own process name: a `pkill -f anvil` meant for another local chain
  // must not take this one down mid-run.
  const child = spawn('anvil', args, { argv0: 'antseed-stress-chain', stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.on('data', () => {});
  const rpc = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
      if (r.ok) return { child, rpc };
    } catch {}
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill('SIGKILL');
  throw new Error('anvil did not start');
}

async function rpcCall(rpc, method, params) {
  const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

function deployAndSetup(rpc, contractsDir) {
  // The deploy needs none of the contract tests, which are most of the compile.
  run('forge', ['script', 'script/Deploy.s.sol', '--skip', 'test', '--rpc-url', rpc, '--broadcast'], { cwd: contractsDir });
  const code = cast(rpc, ['code', C.channels]);
  if (code === '0x') throw new Error('Channels not deployed at expected address');
  // Match Base mainnet: top-ups are allowed once 65% of the deposit is settled (source default 85%).
  send(rpc, KEYS.deployer, C.channels, 'setTopUpSettledThresholdBps(uint256)', process.env.TOPUP_THRESHOLD_BPS ?? '6500');
  // Mint USDC
  send(rpc, KEYS.deployer, C.usdc, 'mint(address,uint256)', ADDR.seller, '100000000');
  send(rpc, KEYS.deployer, C.usdc, 'mint(address,uint256)', ADDR.buyer, '1000000000');
  // Seller: register ERC-8004 identity, stake 50 USDC (agentId 1 on a fresh chain)
  send(rpc, KEYS.seller, C.identity, 'register()');
  send(rpc, KEYS.seller, C.usdc, 'approve(address,uint256)', C.staking, '50000000');
  send(rpc, KEYS.seller, C.staking, 'stake(uint256,uint256)', '1', '50000000');
  // Buyer: operator = self via EIP-712 SetOperator
  const domainSep = call(rpc, C.deposits, 'domainSeparator()(bytes32)');
  const typeHash = run('cast', ['keccak', 'SetOperator(address operator,uint256 nonce)']);
  const enc = run('cast', ['abi-encode', 'f(bytes32,address,uint256)', typeHash, ADDR.buyer, '0']);
  const structHash = run('cast', ['keccak', enc]);
  const digest = run('cast', ['keccak', run('cast', ['concat-hex', '0x1901', domainSep, structHash])]);
  const sig = run('cast', ['wallet', 'sign', '--no-hash', '--private-key', KEYS.buyer, digest]);
  send(rpc, KEYS.buyer, C.deposits, 'setOperator(address,address,uint256,bytes)', ADDR.buyer, ADDR.buyer, '0', sig);
  // Raise the buyer's credit limit (owner-only) so long stress runs fit, then deposit.
  send(rpc, KEYS.deployer, C.deposits, 'setCreditLimitOverride(address,uint256)', ADDR.buyer, '1000000000');
  send(rpc, KEYS.buyer, C.usdc, 'approve(address,uint256)', C.deposits, BUYER_DEPOSIT.toString());
  send(rpc, KEYS.buyer, C.deposits, 'deposit(address,uint256)', ADDR.buyer, BUYER_DEPOSIT.toString());
}

/**
 * Deploy and fund on a throwaway anvil, then dump the state to `stateFile`.
 * Parallel runs sharing it deploy once: the first takes the lock, the others
 * wait for its dump.
 */
export async function prepareChainState({ port, contractsDir, stateFile }) {
  const lock = `${stateFile}.lock`;
  for (const deadline = Date.now() + 300_000; !existsSync(stateFile);) {
    try {
      mkdirSync(lock);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${stateFile}`);
      await new Promise((r) => setTimeout(r, 500));
      continue;
    }
    try {
      if (existsSync(stateFile)) return;
      const { child, rpc } = await startAnvil(port, 0);
      try {
        deployAndSetup(rpc, contractsDir);
        // Written whole, then renamed: a waiting run never reads half a dump.
        writeFileSync(`${stateFile}.tmp`, await rpcCall(rpc, 'anvil_dumpState', []));
        renameSync(`${stateFile}.tmp`, stateFile);
      } finally {
        child.kill('SIGKILL');
        await new Promise((r) => setTimeout(r, 300));
      }
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
}

/** Start a fresh anvil on `port` with the deployed and funded state. */
export async function freshChain({ port, contractsDir, stateFile, blockTime }) {
  await prepareChainState({ port, contractsDir, stateFile });
  const { child, rpc } = await startAnvil(port, blockTime);
  await rpcCall(rpc, 'anvil_loadState', [readFileSync(stateFile, 'utf8').trim()]);
  // Sanity: buyer deposit present and seller staked.
  const bal = call(rpc, C.deposits, 'getBuyerBalance(address)(uint256,uint256,uint256)', ADDR.buyer).split('\n')[0].split(' ')[0];
  if (BigInt(bal) !== BUYER_DEPOSIT) throw new Error(`unexpected buyer balance after loadState: ${bal}`);
  const bps = call(rpc, C.channels, 'TOP_UP_SETTLED_THRESHOLD_BPS()(uint256)').split(' ')[0];
  return { child, rpc, topUpThresholdBps: Number(bps) };
}

export function chainSnapshot(rpc) {
  const [avail, reserved] = call(rpc, C.deposits, 'getBuyerBalance(address)(uint256,uint256,uint256)', ADDR.buyer)
    .split('\n').map((l) => BigInt(l.trim().split(' ')[0]));
  const usdcBal = (a) => BigInt(call(rpc, C.usdc, 'balanceOf(address)(uint256)', a).split(' ')[0]);
  return {
    buyerAvailable: avail, buyerReserved: reserved, buyerBalance: avail + reserved,
    sellerUsdc: usdcBal(ADDR.seller), reserveUsdc: usdcBal(ADDR.deployer),
  };
}

export function readChannel(rpc, channelId) {
  const out = call(rpc, C.channels, 'channels(bytes32)(address,address,uint128,uint128,bytes32,uint256,uint256,uint256,uint8)', channelId)
    .split('\n').map((l) => l.trim().split(' ')[0]);
  return { buyer: out[0], seller: out[1], deposit: BigInt(out[2]), settled: BigInt(out[3]), status: Number(out[8]) };
}

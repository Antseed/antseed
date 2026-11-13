#!/usr/bin/env node
/** Local-only dashboard sandbox. Requires built node/ants packages and Anvil.
 * node scripts/ants-sandbox.mjs [--check] [--restricted] [--browser] [--port 3122]
 * BASE_MAINNET_RPC_URL overrides the public fork source; FORK_BLOCK overrides the pinned block.
 * Ctrl+C stops the owned processes. Run again for a fresh test wallet and chain.
 * --restricted keeps transfers disabled; temporary setup allowlisting is removed before tests.
 * --check exercises the real HTTP write API, then restores claimable rewards for browser testing.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { Contract, Interface, JsonRpcProvider, parseUnits, formatUnits, id as hashId } from 'ethers';
import { getChainConfig, loadOrCreateIdentity } from '../packages/node/dist/index.js';
import { createAntsServer } from '../apps/ants/dist/server.js';
import { stake, registerBinding, rewards } from '../apps/ants/dist/service/index.js';
import { availablePort } from './deployments/runtime/anvil.mjs';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('node scripts/ants-sandbox.mjs [--check] [--restricted] [--browser] [--port 3122]\nOptional: BASE_MAINNET_RPC_URL, FORK_BLOCK. Requires pnpm --filter=@antseed/ants run build and built @antseed/node.');
  process.exit(0);
}
const check = args.includes('--check');
const restricted = args.includes('--restricted');
const browserWallet = args.includes('--browser');
assert(!(browserWallet && check), 'Use the browser e2e driver with --browser, not the local-signing --check.');
let port = 3122;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port') port = Number(args[++i]);
  else if (!['--check', '--restricted', '--browser'].includes(args[i])) throw new Error(`Unknown argument: ${args[i]}`);
}
assert(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid dashboard port');
const base = getChainConfig('base-mainnet');
const forkBlock = Number(process.env.FORK_BLOCK ?? '51304790');
assert(Number.isSafeInteger(forkBlock) && forkBlock > 0, 'Invalid FORK_BLOCK');
const forkUrl = process.env.BASE_MAINNET_RPC_URL || base.rpcUrl;
const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-sandbox-'));
await chmod(dataDir, 0o700);
const rpcPort = await availablePort();
const rpcUrl = `http://127.0.0.1:${rpcPort}`;
let server;
let provider;
let stopping = false;
let anvil;
async function stop() {
  if (stopping) return;
  stopping = true;
  await server?.close();
  provider?.destroy();
  if (anvil && anvil.exitCode === null) {
    const exited = once(anvil, 'exit');
    anvil.kill('SIGTERM');
    const timer = setTimeout(() => anvil.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void stop().finally(() => process.exit(0)); });
const rpc = (method, params = []) => provider.send(method, params);
const report = (message) => console.log(`  ${message}`);
async function sendAs(from, to, abi, method, values = []) {
  report(`Preparing local ${method}`);
  await rpc('anvil_impersonateAccount', [from]);
  try {
    await rpc('anvil_setBalance', [from, '0x56BC75E2D63100000']);
    const hash = await rpc('eth_sendTransaction', [{ from, to, data: abi.encodeFunctionData(method, values), gas: '0x7a1200' }]);
    report(`Submitted ${method}`);
    let receipt;
    const deadline = Date.now() + 120000;
    while (!receipt && Date.now() < deadline) {
      receipt = await rpc('eth_getTransactionReceipt', [hash]);
      if (!receipt) await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(Number(receipt?.status), 1, `${method} reverted`);
    report(`Confirmed ${method}`);
  } finally { await rpc('anvil_stopImpersonatingAccount', [from]); }
}
async function advance(count = 1) {
  await rpc('evm_increaseTime', [604800 * count]);
  await rpc('evm_mine');
  server.context.invalidate();
}
async function api(route, body) {
  const response = await fetch(`http://127.0.0.1:${port}/api/${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(120000),
  });
  const value = await response.json();
  assert(value.ok, `${route}: ${value.error}`);
  return value.data;
}
async function action(route, body) {
  const job = await api(route, body);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const status = await api(`jobs/${job.id}`);
    if (status.status === 'failed') throw new Error(`${route}: ${status.error}`);
    if (status.status === 'done') { report(`PASS ${route}`); return status.result; }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`${route}: job timeout`);
}

const setupTimer = setTimeout(() => {
  console.error('Sandbox setup exceeded 10 minutes. Try a dedicated BASE_MAINNET_RPC_URL.');
  void stop().finally(() => process.exit(1));
}, 600000);
try {
  console.log(`Starting local Anvil fork at block ${forkBlock}. Temporary files: ${dataDir}`);
  anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(rpcPort), '--chain-id', '31337', '--fork-url', forkUrl,
    '--fork-block-number', String(forkBlock), '--silent', '--compute-units-per-second', '100', '--retries', '10', '--disable-min-priority-fee', '--base-fee', '0', '--gas-price', '0'], { stdio: ['ignore', 'ignore', 'pipe'] });
  let startupError;
  anvil.on('error', error => { startupError = error; });
  // Do not print upstream errors: they may include a credential-bearing fork URL.
  anvil.stderr.on('data', () => {});
  const readyUntil = Date.now() + 60000;
  let ready = false;
  while (Date.now() < readyUntil) {
    if (startupError) throw startupError;
    if (anvil.exitCode !== null) throw new Error(`Anvil exited (${anvil.exitCode}); check fork RPC access and block availability.`);
    try {
      const result = await fetch(rpcUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'web3_clientVersion', params: [] }), signal: AbortSignal.timeout(1000) }).then(r => r.json());
      if (/anvil/i.test(result.result)) { ready = true; break; }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  assert(ready, 'Anvil did not start within 60s; check fork RPC access');
  provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
  provider.pollingInterval = 100;
  assert.equal(Number(await rpc('eth_chainId')), 31337);
  const chain = { ...base, chainId: 'base-local', evmChainId: 31337, rpcUrl, fallbackRpcUrls: [], explorerApiUrl: '', networkStatsUrl: '' };
  await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({ payments: { crypto: chain } }, null, 2), { mode: 0o600 });
  const identity = await loadOrCreateIdentity(dataDir);
  const second = await loadOrCreateIdentity(path.join(dataDir, 'second-seller'));
  for (const address of [identity.wallet.address, second.wallet.address]) await rpc('anvil_setBalance', [address, '0x56BC75E2D63100000']);
  server = await createAntsServer({ port, chain, dataDir, browserWallet: false, signer: identity.wallet, address: identity.wallet.address });
  const tokenAbi = new Interface(['function owner() view returns(address)', 'function enableTransfers()', 'function transfer(address,uint256)', 'function setTransferWhitelist(address,bool)']);
  const token = new Contract(chain.antsTokenAddress, ['function owner() view returns(address)', 'function balanceOf(address) view returns(uint256)', 'function transfersEnabled() view returns(bool)', 'function transferWhitelist(address) view returns(bool)', 'function transfer(address,uint256)'], provider);
  const tokenOwner = await token.owner();
  const escrowWasWhitelisted = await token.transferWhitelist(chain.legacyEmissionsEscrowAddress);
  if (restricted) {
    assert.equal(await token.transfersEnabled(), false, 'Pinned fork must still have restricted transfers');
    report('Temporarily allowlisting the test wallet and funding source to seed existing positions; global transfers remain disabled');
    await sendAs(tokenOwner, chain.antsTokenAddress, tokenAbi, 'setTransferWhitelist', [identity.wallet.address, true]);
    if (!escrowWasWhitelisted) await sendAs(tokenOwner, chain.antsTokenAddress, tokenAbi, 'setTransferWhitelist', [chain.legacyEmissionsEscrowAddress, true]);
  } else {
    await sendAs(tokenOwner, chain.antsTokenAddress, tokenAbi, 'enableTransfers');
  }
  await sendAs(chain.legacyEmissionsEscrowAddress, chain.antsTokenAddress, tokenAbi, 'transfer', [identity.wallet.address, parseUnits('100000', 18)]);
  const registryAbi = new Interface(['function owner() view returns(address)', 'function setEmissions(address)', 'function setStaking(address)']);
  const registry = new Contract(chain.registryContractAddress, ['function owner() view returns(address)'], provider);
  const owner = await registry.owner();
  await sendAs(owner, chain.registryContractAddress, registryAbi, 'setEmissions', [chain.usageAccountingAddress]);
  await sendAs(owner, chain.registryContractAddress, registryAbi, 'setStaking', [chain.sellerRegistryAddress]);
  server.context.invalidate();
  const a = await registerBinding(server.context, undefined, report);
  const { AntsContext } = await import('../apps/ants/dist/service/context.js');
  const bctx = new AntsContext({ chain, address: second.wallet.address, signer: second.wallet });
  const b = await registerBinding(bctx, undefined, report);
  for (const amount of ['1000', '500']) await stake(server.context, { agentId: a.agentId, amount, epochs: 12 }, report);
  if (browserWallet) await stake(server.context, { agentId: b.agentId, amount: '100', epochs: 12 }, report);
  if (restricted) {
    await sendAs(tokenOwner, chain.antsTokenAddress, tokenAbi, 'setTransferWhitelist', [identity.wallet.address, false]);
    if (!escrowWasWhitelisted) await sendAs(tokenOwner, chain.antsTokenAddress, tokenAbi, 'setTransferWhitelist', [chain.legacyEmissionsEscrowAddress, false]);
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(identity.wallet.address), false);
    server.context.invalidate();
  }
  await advance(2);
  const accountingAbi = new Interface(['function accruePoints(bytes32,address,address,uint256)']);
  await sendAs(chain.channelsContractAddress, chain.usageAccountingAddress, accountingAbi, 'accruePoints', [hashId(`ants-sandbox:${identity.wallet.address}:${second.wallet.address}`), second.wallet.address, identity.wallet.address, 5000000000n]);
  await advance();
  let initial;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      report('Reading claimable rewards from local contracts');
      initial = await rewards(server.context);
      break;
    } catch (error) {
      if (attempt === 3 || !/timeout|rate limit|429/i.test(error.message)) throw error;
      report('Fork read temporarily unavailable; retrying the read after cooldown (no transactions replayed)');
      await new Promise(resolve => setTimeout(resolve, 21000));
    }
  }
  assert(BigInt(initial.staker.total) > 0n, 'No staker rewards created');
  assert(BigInt(initial.sellerUsage.total) > 0n, 'No seller rewards created');
  if (browserWallet) {
    const { makeDepositsDomain, signSetOperator } = await import('../packages/node/dist/payments/index.js');
    const deposits = new Contract(chain.depositsContractAddress, ['function getOperatorNonce(address) view returns(uint256)', 'function setOperator(address,address,uint256,bytes)'], identity.wallet.connect(provider));
    const nonce = await deposits.getOperatorNonce(second.wallet.address);
    const signature = await signSetOperator(second.wallet, makeDepositsDomain(31337, chain.depositsContractAddress), { operator: identity.wallet.address, nonce });
    await (await deposits.setOperator(second.wallet.address, identity.wallet.address, nonce, signature)).wait();
    await server.close();
    server = await createAntsServer({ port, chain, dataDir, browserWallet: true, address: second.wallet.address });
    // Only the ephemeral Anvil wallet is exposed to the browser test provider.
    await rpc('anvil_impersonateAccount', [identity.wallet.address]);
  }
  await server.listen();
  console.log(`Claimable: ${formatUnits(initial.total, 18)} test ANTS`);
  if (check && restricted) {
    let snapshot = await rpc('evm_snapshot');
    let resetCount = 0;
    async function restoreRestrictedScenario() {
      assert.equal(await rpc('evm_revert', [snapshot]), true);
      snapshot = await rpc('evm_snapshot');
      await server.close();
      server = await createAntsServer({ port, chain, browserWallet: false, dataDir: path.join(dataDir, `restricted-session-${++resetCount}`), signer: identity.wallet, address: identity.wallet.address });
      await server.listen();
    }
    const wallet = identity.wallet.address;
    const balance = await token.balanceOf(wallet);
    const positionsBefore = (await api('positions')).positions;
    const stakedBefore = positionsBefore.reduce((sum, p) => sum + BigInt(p.amount), 0n);
    assert.equal((await api('overview')).wallet.canTransfer, false);
    await assert.rejects(action('positions/stake', { agentId: a.agentId, amount: '1', epochs: 4 }), /transfers are not enabled/);
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal((await api('positions')).positions.length, positionsBefore.length);
    const claimed = await action('rewards/claim', { buckets: ['staker', 'seller'] });
    assert.equal(BigInt(claimed.claimed), BigInt(initial.total));
    assert.equal(await token.balanceOf(wallet), balance + BigInt(initial.total));
    assert.equal((await api('rewards')).total, '0');
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(wallet), false);
    await assert.rejects(token.connect(identity.wallet.connect(provider)).transfer.staticCall(second.wallet.address, 1n), error => error.code === 'CALL_EXCEPTION');
    report('PASS restricted claim: rewards received, transfers still blocked, new wallet stake rejected');
    await restoreRestrictedScenario();
    const compounded = await action('rewards/compound', { epochs: 4, targetAgentId: a.agentId });
    assert.equal(compounded.newPositionIds.length, 3);
    const positionsAfter = (await api('positions')).positions;
    assert.equal(positionsAfter.reduce((sum, p) => sum + BigInt(p.amount), 0n), stakedBefore + BigInt(initial.total));
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal((await api('rewards')).total, '0');
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(wallet), false);
    report('PASS restricted restake: both reward types became positions without spending wallet ANTS');
    await restoreRestrictedScenario();
    assert(BigInt((await api('rewards')).total) > 0n);
    console.log('Restricted-transfer checks passed; fresh restricted wallet and claimable rewards restored.');
  }
  if (check && !restricted) {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/rewards`)).status, 401, 'API must require session authorization');
    assert.equal((await api('config')).evmChainId, 31337);
    const snapshot = await rpc('evm_snapshot');
    const balance = await token.balanceOf(identity.wallet.address);
    const displayed = await api('rewards');
    assert.equal(displayed.total, initial.total);
    const claimed = await action('rewards/claim', { buckets: ['staker', 'seller'] });
    assert.equal((await token.balanceOf(identity.wallet.address)) - balance, BigInt(claimed.claimed));
    assert(BigInt(claimed.claimed) > 0n);
    assert.equal((await api('rewards')).total, '0');
    await action('positions/stake', { agentId: a.agentId, amount: '100', epochs: 12 });
    await advance();
    let list = (await api('positions')).positions;
    const id = list[0].id;
    assert.equal(list[0].amount, parseUnits('100', 18).toString());
    await action('positions/split', { positionId: id, amount: '40' });
    await advance();
    list = (await api('positions')).positions;
    assert.equal(list.slice(0, 2).reduce((sum, p) => sum + BigInt(p.amount), 0n), parseUnits('100', 18));
    assert(!list.some(p => p.id === id), 'Split source must close');
    const parts = list.slice(0, 2).map(p => p.id);
    await action('positions/merge', { positionIds: parts });
    await advance();
    const merged = (await api('positions')).positions[0].id;
    await action('positions/extend', { positionId: merged, epochs: 2 });
    await advance();
    await action('positions/max-lock', { positionId: merged, enable: true });
    await advance();
    await action('positions/max-lock', { positionId: merged, enable: false });
    await advance();
    await action('positions/move', { positionIds: [merged], toAgentId: b.agentId });
    await advance();
    const moved = (await api('positions')).positions[0].id;
    const preview = await api('positions/withdraw/preview', { positionIds: [moved] });
    assert(preview.earlyExit, 'Expect an early-exit preview');
    assert(BigInt(preview.totalSlashed) > 0n);
    await assert.rejects(action('positions/withdraw', { positionIds: [moved], acceptSlashing: false }), /slashing|accept/i);
    await action('positions/withdraw', { positionIds: [moved], acceptSlashing: true, maxSlashedAmount: preview.totalSlashed });
    assert(!(await api('positions')).positions.some(p => p.id === moved), 'Withdrawn position must leave open positions');
    assert.equal(await rpc('evm_revert', [snapshot]), true);
    server.context.invalidate();
    // Recreate the server so neither cached views nor old jobs survive a chain reset.
    await server.close();
    server = await createAntsServer({ port, chain, browserWallet: false, dataDir: path.join(dataDir, 'browser-session'), signer: identity.wallet, address: identity.wallet.address });
    await server.listen();
    assert(BigInt((await api('rewards')).total) > 0n);
    console.log('HTTP lifecycle checks passed; restored fresh claimable rewards for browser tests.');
  }
  await writeFile(path.join(dataDir, 'scenario.json'), JSON.stringify({ rpcUrl, forkBlock, restricted, browserWallet, buyerAddress: second.wallet.address, chainId: 31337, dashboardUrl: server.url, address: identity.wallet.address, agentId: a.agentId, otherAgentId: b.agentId }, null, 2), { mode: 0o600 });
  console.log(`LOCAL TEST ONLY (transfers ${restricted ? 'restricted' : 'enabled'}) — ${server.url}\nRPC: ${rpcUrl}\nWallet: ${identity.wallet.address}\nCtrl+C stops this sandbox. Rerun to reset. Production indexer disabled; local transaction history tracks positions changed in this session.`);
  clearTimeout(setupTimer);
  await once(anvil, 'exit');
  if (!stopping) throw new Error('Anvil stopped unexpectedly');
} catch (error) {
  // Avoid exposing RPC credentials that provider errors can embed.
  console.error(String(error?.message || error).replaceAll(forkUrl, '[fork RPC]'));
  process.exitCode = 1;
} finally { clearTimeout(setupTimer); await stop(); }

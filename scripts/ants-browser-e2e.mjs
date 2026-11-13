#!/usr/bin/env node
/** Verify browser signing against a disposable --restricted --browser sandbox.
 * node scripts/ants-browser-e2e.mjs /absolute/path/to/scenario.json [vpr|stake-sources|legacy|name-filter]
 * All mutations are restricted to local Anvil and reverted after each scenario.
 * This drives the wallet/API protocol; extension UI is tested separately.
 */
import assert from 'node:assert/strict';
import { readFile, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { Contract, JsonRpcProvider, parseUnits, ZeroAddress } from 'ethers';
import { createAntsServer } from '../apps/ants/dist/server.js';
import { createServer as createPaymentsServer } from '../apps/payments/dist/server.js';
import { runLegacyRewardScenarios } from './ants-legacy-rewards-e2e.mjs';
const scenarioPath = process.argv[2];
assert(scenarioPath, 'Pass scenario.json from a running --restricted --browser sandbox');
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const chain = JSON.parse(await readFile(path.join(path.dirname(scenarioPath), 'config.json'), 'utf8')).payments.crypto;
assert(scenario.browserWallet && scenario.restricted && chain.evmChainId === 31337);
assert.equal(chain.rpcUrl, scenario.rpcUrl);
assert.deepEqual(chain.fallbackRpcUrls, []);
assert.equal(chain.explorerApiUrl, '');
assert(['127.0.0.1', 'localhost'].includes(new URL(chain.rpcUrl).hostname));
const provider = new JsonRpcProvider(chain.rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
provider.pollingInterval = 100;
const rpc = (method, params = []) => provider.send(method, params);
assert.equal(await rpc('eth_chainId'), '0x7a69');
assert.match(await rpc('web3_clientVersion'), /anvil/i);
const originalBlock = await rpc('eth_getBlockByNumber', ['latest', false]);
const wallet = scenario.address;
const buyer = scenario.buyerAddress;
assert.notEqual(wallet.toLowerCase(), buyer.toLowerCase());
const token = new Contract(chain.antsTokenAddress, ['function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)', 'function transfersEnabled() view returns(bool)', 'function transferWhitelist(address) view returns(bool)', 'function owner() view returns(address)', 'function enableTransfers()', 'function transfer(address,uint256)'], provider);
let server;
let completedActions = 0;
let authorizationOpens = 0;
let passedScenarios = 0;
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function api(route, body, attempt = 0) {
  const response = await fetch(`${new URL(server.url).origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${server.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const reply = await response.json();
  if (!reply.ok && body === undefined && attempt < 3 && /timeout|rate limit|429/i.test(reply.error)) {
    console.log(`Retrying read ${route} after temporary fork RPC failure`);
    await new Promise(resolve => setTimeout(resolve, 21000));
    return api(route, body, attempt + 1);
  }
  assert(reply.ok, `${route}: ${reply.error}`);
  return reply.data;
}
const connect = (address = wallet) => api('wallet', { address, chainId: 31337 });
async function advance() {
  const duration = (await server.context.stack()).epochDuration;
  await rpc('evm_increaseTime', [duration]); await rpc('evm_mine');
  await api('wallet', {}); await connect();
}
async function action(route, body, options = {}) {
  const job = await api(route, body);
  const hashes = new Map();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const pending = await api('wallet/request');
    if (pending && !pending.submittedHash) {
      assert.equal(pending.from.toLowerCase(), wallet.toLowerCase());
      assert.equal(pending.chainId, 31337);
      if (options.reject) await api('wallet/result', { id: pending.id, error: 'User rejected the request' });
      else {
        assert(!hashes.has(pending.id), 'Never broadcast the same step twice');
        await api('wallet/begin', { id: pending.id });
        const hash = await rpc('eth_sendTransaction', [{ from: pending.from, to: pending.to, data: pending.data, value: `0x${BigInt(pending.value).toString(16)}`, gas: '0x7a1200' }]);
        hashes.set(pending.id, hash);
        await api('wallet/result', { id: pending.id, hash });
      }
    }
    const current = await api(`jobs/${job.id}`);
    if (current.status === 'done') return { result: current.result, approvals: hashes.size };
    if (current.status === 'failed') throw new Error(current.error);
    await pause();
  }
  throw new Error(`Timed out: ${route}. Do not retry without inspecting the submitted transactions.`);
}
const open = async () => (await api('positions')).positions.filter(p => !p.withdrawn && !p.closedAtEpoch);
async function isolate(label, run) {
  const filter = process.argv[3];
  if (filter === 'stake-sources' ? !['identity separation', 'buyer reward staking', 'seller reward staking', 'position reward staking'].some(prefix => label.startsWith(prefix)) : filter === 'vpr' ? !['identity separation', 'buyer authorization', 'buyer claim', 'buyer reward staking', 'wallet compound'].some(prefix => label.startsWith(prefix)) : filter && !label.includes(filter)) return;
  const snapshot = await rpc('evm_snapshot');
  const dataDir = await mkdtemp(path.join(tmpdir(), 'ants-wallet-e2e-'));
  try {
    completedActions = 0; authorizationOpens = 0;
    server = await createAntsServer({ port: 0, browserWallet: true, address: buyer, chain, dataDir,
      onAuthorize: async () => { authorizationOpens++; },
      onActionFinished: () => { completedActions++; },
    });
    await server.listen(); await connect();
    await run();
    passedScenarios++;
    console.log(`PASS ${label}`);
  } finally {
    await server?.close();
    assert.equal(await rpc('evm_revert', [snapshot]), true);
  }
}
try {
  await isolate('identity separation, wrong wallet/network, rejection, restricted new stake', async () => {
    const config = await api('config'); assert.equal(config.buyerAddress, buyer); assert.equal(config.address, wallet);
    assert.equal(server.context.signer?.constructor.name, 'BrowserSigner');
    assert.equal((await fetch(`${new URL(server.url).origin}/api/config`)).status, 401);
    await assert.rejects(api('wallet', { address: wallet, chainId: 8453 }), /network/);
    const before = await token.balanceOf(wallet);
    await assert.rejects(action('positions/stake', { agentId: scenario.agentId, amount: '1', epochs: 4 }), /transfers are not enabled/);
    await assert.rejects(action('rewards/claim', { buckets: [], scope: 'buyer' }, { reject: true }), /rejected/);
    assert.equal(await token.balanceOf(wallet), before);
    await connect(buyer);
    assert.equal((await api('rewards')).buyerUsage.claimable, false);
    await assert.rejects(action('rewards/claim', { buckets: [], scope: 'buyer' }), /operator|authorized|No claimable/);
    await connect(); assert.equal((await api('rewards')).buyerUsage.claimable, true);
  });
  await isolate('buyer authorization through existing payments flow and retired claim handoff', async () => {
    const deposits = new Contract(chain.depositsContractAddress, [
      'function transferOperator(address,address)', 'function setOperator(address,address,uint256,bytes)',
      'function getOperator(address) view returns(address)',
    ], await provider.getSigner(wallet));
    await (await deposits.transferOperator(buyer, ZeroAddress)).wait();
    await api('wallet', { address: wallet, chainId: 31337, refresh: true });
    assert.equal((await api('rewards')).buyerUsage.operator, null);
    await assert.rejects(action('rewards/claim', { buckets: [], scope: 'buyer' }), /authorized/);
    await api('wallet/authorize', {});
    assert.equal(authorizationOpens, 1);
    let reopened = 0;
    const payments = await createPaymentsServer({ port: 0,
      dataDir: path.join(path.dirname(scenarioPath), 'second-seller'), chainOverrides: chain,
      onOpenRewards: async () => { reopened++; },
    });
    try {
      const headers = { authorization: `Bearer ${payments.bearerToken}` };
      assert.equal((await payments.inject({ method: 'POST', url: '/api/pay/open-rewards' })).statusCode, 401);
      assert.equal((await payments.inject({ method: 'POST', url: '/api/pay/open-rewards', headers })).statusCode, 200);
      assert.equal(reopened, 1);
      const signed = await payments.inject({ method: 'POST', url: '/api/operator/sign', headers, payload: { operator: wallet } });
      assert.equal(signed.statusCode, 200, signed.body);
      const authorization = signed.json();
      assert.equal(authorization.buyer.toLowerCase(), buyer.toLowerCase());
      await (await deposits.setOperator(buyer, wallet, authorization.nonce, authorization.signature)).wait();
      assert.equal((await deposits.getOperator(buyer)).toLowerCase(), wallet.toLowerCase());
      await api('wallet', { address: wallet, chainId: 31337, refresh: true });
      assert.equal((await api('rewards')).buyerUsage.claimable, true);
      assert.equal(await token.transfersEnabled(), false);
      console.log('  PASS: signed buyer authorization, on-chain operator, session refresh, protected old-link handoff');
    } finally { await payments.close(); }
  });
  await isolate('buyer claim credits the authorized signer and marks the originating buyer epoch', async () => {
    const rewards = await api('rewards'); assert(BigInt(rewards.buyerUsage.total) > 0n);
    const before = await token.balanceOf(wallet), buyerBefore = await token.balanceOf(buyer);
    const { result } = await action('rewards/claim', { buckets: [], scope: 'buyer' });
    assert.equal(completedActions, 1, 'VPR receives completion notification');
    const afterRewards = await api('rewards');
    assert.equal(afterRewards.staker.total, rewards.staker.total);
    assert.equal(afterRewards.sellerUsage.total, rewards.sellerUsage.total);
    const repeated = await action('rewards/claim', { buckets: [], scope: 'buyer' });
    assert.equal(repeated.approvals, 0, 'A repeated claim never resends completed transactions');
    assert.equal(await token.balanceOf(wallet) - before, BigInt(result.claimed));
    assert.equal(result.claimed, rewards.buyerUsage.total);
    assert.equal(await token.balanceOf(buyer), buyerBefore);
    assert.equal((await api('rewards')).buyerUsage.total, '0');
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(wallet), false);
    await assert.rejects(token.transfer.staticCall(buyer, 1n, { from: wallet }));
  });
  await isolate('buyer reward staking creates a position owned by the authorized signer', async () => {
    const before = await open(), balance = await token.balanceOf(wallet);
    const reward = BigInt((await api('rewards')).buyerUsage.total);
    await action('rewards/stake-usage', { side: 'buyer', epochs: 4, stakeAgentId: scenario.otherAgentId });
    const created = (await open()).filter(p => !before.some(b => b.id === p.id));
    assert.equal(created.reduce((n, p) => n + BigInt(p.amount), 0n), reward);
    for (const p of created) assert.equal((await server.context.requirePools().positionsBatch([p.id]))[0].owner.toLowerCase(), wallet.toLowerCase());
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal((await api('rewards')).buyerUsage.total, '0');
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(wallet), false);
    await assert.rejects(action('rewards/stake-usage', { side: 'buyer', epochs: 4, stakeAgentId: scenario.otherAgentId }), /No unclaimed/);
  });
  await isolate('seller reward staking keeps ownership and source pool without spending wallet ANTS', async () => {
    const before = await open(), balance = await token.balanceOf(wallet), rewards = await api('rewards');
    const amount = BigInt(rewards.sellerUsage.total); assert(amount > 0n);
    await action('rewards/stake-usage', { side: 'seller', epochs: 4 });
    const created = (await open()).filter(p => !before.some(b => b.id === p.id));
    assert.equal(created.reduce((n, p) => n + BigInt(p.amount), 0n), amount);
    for (const p of created) {
      assert.equal(p.agentId, rewards.sellerUsage.agentId);
      assert.equal((await server.context.requirePools().positionsBatch([p.id]))[0].owner.toLowerCase(), wallet.toLowerCase());
    }
    const after = await api('rewards');
    assert.equal(after.sellerUsage.total, '0'); assert.equal(after.buyerUsage.total, rewards.buyerUsage.total);
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal(await token.transfersEnabled(), false); assert.equal(await token.transferWhitelist(wallet), false);
  });
  await isolate('position reward staking consumes only the selected position rewards', async () => {
    const before = await open(), balance = await token.balanceOf(wallet), rewards = await api('rewards');
    const source = rewards.staker.positions.find(p => BigInt(p.amount) > 0n); assert(source);
    await action('rewards/restake', { positionIds: [source.id], epochs: 4 });
    const created = (await open()).filter(p => !before.some(b => b.id === p.id));
    assert.equal(created.reduce((n, p) => n + BigInt(p.amount), 0n), BigInt(source.amount));
    for (const p of created) {
      assert.equal(p.agentId, source.agentId);
      assert.equal((await server.context.requirePools().positionsBatch([p.id]))[0].owner.toLowerCase(), wallet.toLowerCase());
    }
    const after = await api('rewards');
    assert.equal(BigInt(after.staker.total), BigInt(rewards.staker.total) - BigInt(source.amount));
    assert.equal(after.buyerUsage.total, rewards.buyerUsage.total); assert.equal(after.sellerUsage.total, rewards.sellerUsage.total);
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal(await token.transfersEnabled(), false); assert.equal(await token.transferWhitelist(wallet), false);
  });
  await isolate('wallet compound leaves buyer rewards untouched', async () => {
    const before = await api('rewards');
    const buyerReward = before.buyerUsage.total;
    assert(BigInt(buyerReward) > 0n);
    await action('rewards/compound', { epochs: 4, includeBuyer: false, targetAgentId: scenario.agentId });
    const after = await api('rewards');
    assert.equal(after.buyerUsage.total, buyerReward);
    assert.equal(after.staker.total, '0'); assert.equal(after.sellerUsage.total, '0');
    assert.equal(await token.transfersEnabled(), false);
  });
  await isolate('compound staker, seller and buyer rewards then move allocations with restricted transfers', async () => {
    const before = await open(), balance = await token.balanceOf(wallet);
    const rewards = await api('rewards');
    const total = BigInt(rewards.staker.total) + BigInt(rewards.sellerUsage.total) + BigInt(rewards.buyerUsage.total);
    const { approvals } = await action('rewards/compound', { epochs: 4, targetAgentId: scenario.otherAgentId });
    assert(approvals >= 3, 'Compound must await several approvals');
    const after = await open();
    assert.equal(after.reduce((n,p) => n + BigInt(p.amount), 0n) - before.reduce((n,p) => n + BigInt(p.amount), 0n), total);
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal((await api('rewards')).total, '0');
    assert.equal(await token.transfersEnabled(), false);
  });
  await isolate('whole-position move preserves principal/lock and source rewards; split, merge, extend and maximum lock', async () => {
    const initial = await open(), source = initial.find(p => p.agentId === scenario.agentId);
    const total = initial.reduce((n,p) => n + BigInt(p.amount), 0n);
    const powerBefore = (await api('pools')).yourTotalPower;
    await assert.rejects(action('positions/move', { positionIds: [source.id], toAgentId: scenario.otherAgentId, amount: '40' }), /Partial moves are not supported/);
    const { approvals } = await action('positions/move', { positionIds: [source.id], toAgentId: scenario.otherAgentId });
    assert.equal(approvals, 1);
    assert.equal((await api('pools')).yourTotalPower, powerBefore, 'Move power changes take effect next epoch');
    let all = (await api('positions')).positions;
    assert(all.some(p => p.id === source.id && p.closedAtEpoch));
    assert((await api('rewards')).staker.positions.some(p => p.positionId === source.id || p.id === source.id));
    let live = all.filter(p => !p.withdrawn && !p.closedAtEpoch);
    assert.equal(live.reduce((n,p) => n + BigInt(p.amount), 0n), total);
    let moved = live.find(p => !initial.some(i => i.id === p.id) && p.agentId === scenario.otherAgentId);
    assert.equal(moved.amount, source.amount); assert.equal(moved.stakeEndEpoch, source.stakeEndEpoch);
    await advance();
    await action('positions/split', { positionId: moved.id, amount: '15' }); await advance();
    const partAmounts = [parseUnits('15', 18).toString(), (BigInt(source.amount) - parseUnits('15', 18)).toString()];
    live = await open(); const parts = live.filter(p => p.agentId === scenario.otherAgentId && partAmounts.includes(p.amount)); assert.equal(parts.length, 2);
    await action('positions/merge', { positionIds: parts.map(p => p.id) }); await advance();
    moved = (await open()).find(p => p.agentId === scenario.otherAgentId && p.amount === source.amount);
    await action('positions/extend', { positionId: moved.id, epochs: 2 }); await advance();
    await action('positions/max-lock', { positionId: moved.id, enable: true }); await advance();
    await assert.rejects(action('positions/move', { positionIds: [moved.id], toAgentId: scenario.agentId }), /maximum lock/);
    await action('positions/max-lock', { positionId: moved.id, enable: false }); await advance();
    await action('positions/move', { positionIds: [moved.id], toAgentId: scenario.agentId });
    assert.equal(await token.transfersEnabled(), false);
  });
  await isolate('withdraw returns principal less burn, keeps rewards discoverable and transfers restricted', async () => {
    const source = (await open()).find(p => p.agentId === scenario.agentId);
    const before = await token.balanceOf(wallet), burned = await token.balanceOf('0x000000000000000000000000000000000000dEaD');
    const preview = await api('positions/withdraw/preview', { positionIds: [source.id] });
    assert.equal(preview.simulationError, null); assert.equal(preview.transfersRestricted, true);
    assert(BigInt(preview.pendingRewards) > 0n); assert(BigInt(preview.totalSlashed) > 0n);
    await assert.rejects(action('positions/withdraw', { positionIds: [source.id], acceptSlashing: false }), /burns/);
    await action('positions/withdraw', { positionIds: [source.id], acceptSlashing: true, maxSlashedAmount: preview.totalSlashed });
    assert.equal(await token.balanceOf(wallet) - before, BigInt(preview.totalReturned));
    assert.equal(await token.balanceOf('0x000000000000000000000000000000000000dEaD') - burned, BigInt(preview.totalSlashed));
    const history = (await api('positions')).positions.find(p => p.id === source.id);
    assert(history?.withdrawn); assert(BigInt(history.pendingReward) > 0n);
    const after = await token.balanceOf(wallet);
    await action('rewards/claim', { buckets: ['staker'] });
    assert(await token.balanceOf(wallet) > after);
    await assert.rejects(token.transfer.staticCall(buyer, 1n, { from: wallet }));
  });
  await isolate('new stake uses browser approvals when transfers are enabled', async () => {
    const owner = await token.owner(); await rpc('anvil_impersonateAccount', [owner]);
    try { await (await token.connect(await provider.getSigner(owner)).enableTransfers()).wait(); }
    finally { await rpc('anvil_stopImpersonatingAccount', [owner]); }
    const before = await token.balanceOf(wallet);
    const { approvals } = await action('positions/stake', { agentId: scenario.agentId, amount: '2', epochs: 4 });
    assert(approvals >= 1); assert.equal(before - await token.balanceOf(wallet), parseUnits('2', 18));
  });
  await runLegacyRewardScenarios({ isolate, api, action, open, provider, rpc, wallet, buyer, chain, getServer: () => server });
  assert(passedScenarios > 0, 'No Anvil scenarios matched the requested filter');
  assert.equal((await rpc('eth_getBlockByNumber', ['latest', false])).hash, originalBlock.hash, 'The complete suite must restore the original Anvil block');
  console.log(`${passedScenarios} ${process.argv[3] ? 'selected' : 'total'} browser signing Anvil scenarios passed. Original chain state restored.`);
} finally { provider.destroy(); }

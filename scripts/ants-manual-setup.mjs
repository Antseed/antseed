import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AbiCoder, Contract, ContractFactory, JsonRpcProvider, keccak256, toBeHex, ZeroAddress } from 'ethers';
import { AntsContext } from '../apps/ants/dist/service/context.js';
import { artifacts } from './ants-legacy-rewards-e2e.mjs';

const scenarioPath = process.argv[2];
assert(scenarioPath, 'Pass scenario.json from a fresh running --restricted --browser sandbox');
const directory = path.dirname(scenarioPath);
const scenario = JSON.parse(await readFile(scenarioPath, 'utf8'));
const chain = JSON.parse(await readFile(path.join(directory, 'config.json'), 'utf8')).payments.crypto;
const dashboard = new URL(scenario.dashboardUrl);
assert(scenario.browserWallet && scenario.restricted && scenario.chainId === 31337 && chain.evmChainId === 31337);
assert(['127.0.0.1', 'localhost'].includes(new URL(scenario.rpcUrl).hostname));
assert(['127.0.0.1', 'localhost'].includes(dashboard.hostname));
assert.equal(chain.rpcUrl, scenario.rpcUrl);
assert.deepEqual(chain.fallbackRpcUrls, []);
const token = new URLSearchParams(dashboard.hash.slice(1)).get('token');
const provider = new JsonRpcProvider(scenario.rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, batchMaxCount: 1 });
provider.pollingInterval = 100;
const rpc = (method, params = []) => provider.send(method, params);
const pause = () => new Promise(resolve => setTimeout(resolve, 100));
async function api(route, body, attempt = 0) {
  const response = await fetch(new URL(`/api/${route}`, dashboard), { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(120000) });
  const result = await response.json();
  if (!result.ok && body === undefined && attempt < 3 && /timeout|rate limit|429/i.test(result.error)) {
    console.log(`Waiting for the fork to warm ${route}; no transactions are replayed`);
    await new Promise(resolve => setTimeout(resolve, 21000));
    return api(route, body, attempt + 1);
  }
  assert(result.ok, `${route}: ${result.error}`);
  return result.data;
}
const refresh = () => api('wallet', { address: scenario.address, chainId: 31337, refresh: true });
async function action(route, body) {
  const job = await api(route, body);
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const pending = await api('wallet/request');
    if (pending && !pending.submittedHash) {
      assert.equal(pending.from.toLowerCase(), scenario.address.toLowerCase());
      assert.equal(pending.chainId, 31337);
      await api('wallet/begin', { id: pending.id });
      const hash = await rpc('eth_sendTransaction', [{ from: pending.from, to: pending.to, data: pending.data, value: toBeHex(BigInt(pending.value)), gas: '0x7a1200' }]);
      await api('wallet/result', { id: pending.id, hash });
    }
    const current = await api(`jobs/${job.id}`);
    if (current.status === 'done') return current.result;
    if (current.status === 'failed') throw new Error(current.error);
    await pause();
  }
  throw new Error('Setup action timed out. Inspect the running job before retrying.');
}
async function ownerSend(contract, method, values) {
  const owner = await contract.owner();
  await rpc('anvil_impersonateAccount', [owner]);
  try {
    await rpc('anvil_setBalance', [owner, '0x56BC75E2D63100000']);
    await (await contract.connect(await provider.getSigner(owner))[method](...values)).wait();
  } finally { await rpc('anvil_stopImpersonatingAccount', [owner]); }
}

try {
  assert.equal(await rpc('eth_chainId'), '0x7a69');
  assert.match(await rpc('web3_clientVersion'), /anvil/i);
  assert(!(await api('jobs')).some(job => job.status === 'running'), 'Finish existing wallet jobs first');
  await refresh();
  const tokenContract = new Contract(chain.antsTokenAddress, ['function owner() view returns(address)', 'function setTransferWhitelist(address,bool)', 'function transfersEnabled() view returns(bool)'], provider);
  assert.equal(await tokenContract.transfersEnabled(), false);
  await ownerSend(tokenContract, 'setTransferWhitelist', [scenario.address, true]);
  await refresh();
  const initial = (await api('positions')).positions;
  const mature = await action('positions/stake', { agentId: scenario.agentId, amount: '75', epochs: 1 });
  const maximum = await action('positions/stake', { agentId: scenario.agentId, amount: '125', epochs: 12 });
  const newPositions = (await api('positions')).positions.filter(position => !initial.some(previous => previous.id === position.id));
  const maximumId = newPositions.find(position => BigInt(position.amount) === 125n * 10n ** 18n).id;
  const duration = (await api('overview')).epoch.epochDuration;
  await rpc('evm_increaseTime', [duration]); await rpc('evm_mine'); await refresh();
  await action('positions/max-lock', { positionId: maximumId, enable: true });
  await rpc('evm_increaseTime', [duration]); await rpc('evm_mine'); await refresh();
  const pending = await action('positions/stake', { agentId: scenario.otherAgentId, amount: '200', epochs: 12 });

  console.log('Prepared matured, max-locked, active and pending positions. Preparing legacy rewards.');
  const ctx = new AntsContext({ chain, address: scenario.address, buyerAddress: scenario.buyerAddress });
  const stack = await ctx.stack();
  const epoch = stack.effectiveEpoch - 1;
  const legacy = new Contract(stack.legacyEmissions, [
    'function owner() view returns(address)', 'function MIGRATION_EPOCH() view returns(uint256)',
    'function epochParams(uint256) view returns(uint256,uint256,uint256,uint256,uint256,uint256,bool)',
    'function epochTotalSellerPoints(uint256) view returns(uint256)', 'function epochTotalBuyerPoints(uint256) view returns(uint256)',
    'function userSellerPoints(address,uint256) view returns(uint256)', 'function userBuyerPoints(address,uint256) view returns(uint256)',
    'function sellerRewardsPool() view returns(address)', 'function setSellerUnlockPolicy(address)',
  ], provider);
  assert(epoch > Number(await legacy.MIGRATION_EPOCH()));
  const parameters = await legacy.epochParams(epoch);
  assert(parameters[6] && parameters[0] > 0n && parameters[1] > 0n);
  const compiled = artifacts();
  const layout = compiled['legacy/AntseedEmissionsV2.sol'].AntseedEmissionsV2.storageLayout.storage;
  const mappingSlot = (label, keys) => {
    const field = layout.find(entry => entry.label === label);
    assert(field && field.offset === 0 && field.type.startsWith('t_mapping'));
    return keys.reduce((slot, [type, value]) => keccak256(AbiCoder.defaultAbiCoder().encode([type, 'uint256'], [value, slot])), BigInt(field.slot));
  };
  for (const [side, account] of [['Seller', scenario.address], ['Buyer', scenario.buyerAddress]]) {
    const total = await legacy[`epochTotal${side}Points`](epoch);
    const totalSlot = mappingSlot(`epochTotal${side}Points`, [['uint256', epoch]]);
    const userSlot = mappingSlot(`user${side}Points`, [['address', account], ['uint256', epoch]]);
    assert.equal(BigInt(await provider.getStorage(legacy.target, totalSlot)), total);
    assert.equal(await legacy[`user${side}Points`](account, epoch), 0n, 'Legacy fixture already exists; use a fresh sandbox');
    const points = total / 100n + 1000n;
    await rpc('anvil_setStorageAt', [legacy.target, totalSlot, toBeHex(total + points, 32)]);
    await rpc('anvil_setStorageAt', [legacy.target, userSlot, toBeHex(points, 32)]);
    assert.equal(await legacy[`user${side}Points`](account, epoch), points);
  }
  const pool = new Contract(await legacy.sellerRewardsPool(), ['function owner() view returns(address)', 'function setSellerClaimPolicy(address)'], provider);
  const deploy = async (source, name, args) => {
    const artifact = compiled[source][name];
    const contract = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, await provider.getSigner(scenario.address)).deploy(...args);
    await contract.waitForDeployment();
    return contract;
  };
  const washStatus = await deploy('test/mocks/AntsRewardsSandbox.sol', 'AntsRewardsSandboxWashStatus', []);
  const policy = await deploy('policies/AntseedLegacySellerClaimPolicy.sol', 'AntseedLegacySellerClaimPolicy', [legacy.target, epoch, 1000, washStatus.target]);
  await ownerSend(legacy, 'setSellerUnlockPolicy', [ZeroAddress]);
  await ownerSend(pool, 'setSellerClaimPolicy', [policy.target]);
  await ownerSend(tokenContract, 'setTransferWhitelist', [pool.target, true]);
  await refresh();
  const positions = await api('positions');
  const rewards = await api('rewards');
  assert(positions.positions.some(position => position.maxLocked));
  assert(positions.positions.some(position => position.state === 'matured'));
  assert(BigInt(rewards.legacy.buyer) > 0n && BigInt(rewards.legacy.seller) > 0n);
  assert(BigInt(rewards.buyerUsage.total) > 0n && BigInt(rewards.sellerUsage.total) > 0n && BigInt(rewards.staker.total) > 0n);
  const summary = { chainId: 31337, rpcUrl: scenario.rpcUrl, address: scenario.address, buyerAddress: scenario.buyerAddress, maximumId, mature, maximum, pending, positions: positions.positions, rewards };
  await writeFile(path.join(directory, 'manual-fixtures.json'), JSON.stringify(summary, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ ready: true, positions: positions.positions.map(({ id, state, maxLocked, amount, changePending }) => ({ id, state, maxLocked, amount, changePending })), rewardSources: ['staker', 'seller', 'buyer', 'legacy seller', 'legacy buyer'], walletTransfers: 'allowlisted; QA controls can restrict again' }, null, 2));
} finally { provider.destroy(); }

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { Interface, ZeroAddress, type AbstractSigner } from 'ethers';
import { SellerPoolsClient } from './evm/seller-pools-client.js';
import { SellerPoolsRewardsClient } from './evm/seller-pools-rewards-client.js';
import { SellerRegistryClient } from './evm/seller-registry-client.js';
import { ANTSTokenClient } from './evm/ants-token-client.js';

const address = '0x0000000000000000000000000000000000000011';
const contractAddress = '0x0000000000000000000000000000000000000022';
const config = { rpcUrl: 'http://127.0.0.1:1', contractAddress, evmChainId: 31337 };

test('seller pools client reads the contract slashing estimate', async () => {
  const client = new SellerPoolsClient({ ...config, antsTokenAddress: contractAddress });
  const abi = new Interface(['function earlyExitSlashBps(uint256) view returns (uint256)']);
  Object.defineProperty(client, '_provider', { value: {
    call: async (transaction: { data: string }) => {
      const call = abi.parseTransaction(transaction)!;
      assert.equal(call.name, 'earlyExitSlashBps');
      assert.equal(call.args[0], 7n);
      return abi.encodeFunctionResult(call.name, [2500n]);
    },
  } });
  assert.ok(Object.hasOwn(SellerPoolsClient.prototype, 'earlyExitSlashBps'));
  assert.equal(await client.earlyExitSlashBps(7), 2500);
});

test('registration distinguishes legacy fallback, persists explicitly, and is idempotent', async () => {
  let legacy = true;
  let registered = false;
  let writes = 0;
  const registry = Object.assign(new SellerRegistryClient(config), {
    getAgentId: async () => legacy || registered ? 7 : 0,
    isRegisteredSeller: async () => registered,
    registerSeller: async () => { writes++; registered = true; return 'confirmed'; },
  });
  assert.equal(await registry.getRegisteredAgentId(address), 0);
  assert.equal(writes, 0);
  const hashes: string[] = [];
  assert.equal(await registry.registerSellerBinding({ getAddress: async () => address } as AbstractSigner, 7, (hash) => { hashes.push(hash); }), true);
  legacy = false;
  assert.equal(await registry.getRegisteredAgentId(address), 7);
  assert.equal(await registry.registerSellerBinding({ getAddress: async () => address } as AbstractSigner, 7, () => {}), false);
  assert.equal(writes, 1);
  assert.deepEqual(hashes, ['confirmed']);
});

test('registration reports a confirmed transaction before verification failure', async () => {
  const hashes: string[] = [];
  const registry = Object.assign(new SellerRegistryClient(config), { getAgentId: async () => 7, isRegisteredSeller: async () => false, registerSeller: async () => 'confirmed' });
  await assert.rejects(registry.registerSellerBinding({ getAddress: async () => address } as AbstractSigner, 7, (hash) => { hashes.push(hash); }), /could not be verified/);
  assert.deepEqual(hashes, ['confirmed']);
});

test('explicit binding reads the existing agentSeller getter, not just getAgentId', async () => {
  const client = new SellerRegistryClient(config);
  const abi = new Interface(['function agentSeller(uint256 agentId) view returns (address)']);
  client.getAgentId = async () => 7;
  let bound = ZeroAddress;
  Object.defineProperty(client, '_provider', { value: { call: async () => abi.encodeFunctionResult('agentSeller', [bound]) } });
  assert.equal(await client.isRegisteredSeller(address, 7), false);
  bound = address;
  assert.equal(await client.isRegisteredSeller(address, 7), true);
});

test('registration rejects a conflicting identity before submitting a transaction', async () => {
  const registry = new SellerRegistryClient(config);
  registry.getAgentId = async () => 7;
  registry.registerSeller = async () => { throw new Error('unexpected transaction'); };
  await assert.rejects(registry.registerSellerBinding({ getAddress: async () => address } as AbstractSigner, 8), /already bound to agent 7/);
});

test('empty reward previews do not contact the RPC', async () => {
  const client = new SellerPoolsRewardsClient(config);
  Object.defineProperty(client, '_provider', { value: {
    getBlockNumber: async () => { throw new Error('unexpected RPC request'); },
  } });
  assert.deepEqual(await client.previewStakerRewards([]), []);
});

test('position pagination includes every page', async () => {
  const ids = Array.from({ length: 513 }, (_, index) => index + 1);
  const client = new SellerPoolsClient({ ...config, antsTokenAddress: contractAddress });
  client.stakerPositionIds = async (_address, offset = 0, limit = 256) => ids.slice(offset, offset + limit);
  assert.deepEqual(await client.allStakerPositionIds(address), ids);
});

test('preview uses only existing view selectors at one block, including unindexed epochs', async () => {
  const client = new SellerPoolsRewardsClient(config);
  const abi = new Interface([
    'function sellerPools() view returns (address)', 'function usageAccounting() view returns (address)',
    'function positions(uint256) view returns (address,uint256,uint256,uint256,uint64,uint64,uint64,bool)',
    'function currentEpoch() view returns (uint256)', 'function positionClaimCursor(uint256) view returns (uint256)',
    'function poolRewardIndexNextEpoch(uint256) view returns (uint256)', 'function initialIndexEpoch() view returns (uint256)',
    'function positionPowerSegmentAt(uint256,uint256) view returns (uint256,uint256,uint256)',
    'function poolCumulativeRewardPerWeightAt(uint256,uint256) view returns (uint256)',
    'function poolCumulativeEpochRewardPerWeightAt(uint256,uint256) view returns (uint256)',
    'function poolWeightAtEpoch(uint256,uint256) view returns (uint256)', 'function poolEpochEmissions(uint256,uint256) view returns (bool,uint256)',
    'function weightedPoolPointsByEpoch(uint256,uint256) view returns (uint256)', 'function totalWeightedPoolPointsByEpoch(uint256) view returns (uint256)',
    'function stakerEpochBudget(uint256) view returns (uint256)',
  ]);
  let reads = 0;
  let block = 123;
  Object.defineProperty(client, '_provider', { value: {
    getBlockNumber: async () => block,
    call: async (transaction: { data: string; blockTag: number }) => {
      assert.equal(transaction.blockTag, block);
      reads++;
      const call = abi.parseTransaction(transaction)!;
      let result: unknown[];
      switch (call.name) {
        case 'sellerPools': case 'usageAccounting': result = [contractAddress]; break;
        case 'positions': result = [address, 7, 3, 3, 1, 4, 0, false]; break;
        case 'currentEpoch': result = [block === 123 ? 3 : 2]; break;
        case 'initialIndexEpoch': result = [1]; break;
        case 'positionPowerSegmentAt': result = [4, 0, 100]; break;
        case 'poolWeightAtEpoch': result = [call.args[1] === 1n ? 10 : 9]; break;
        case 'poolEpochEmissions': result = [false, 0]; break;
        case 'weightedPoolPointsByEpoch': case 'totalWeightedPoolPointsByEpoch': result = [1]; break;
        case 'stakerEpochBudget': result = [call.args[0] === 1n ? 100 : 101]; break;
        default: result = [0];
      }
      return abi.encodeFunctionResult(call.name, result);
    },
  } });
  assert.equal(await client.previewStakerReward(1), 157n);
  const firstReads = reads;
  reads = 0;
  assert.deepEqual(await client.previewStakerRewards([1, 1]), [157n, 157n]);
  assert.equal(reads, firstReads);
  block = 124;
  assert.equal(await client.previewStakerReward(1), 90n);
  assert.ok(reads > firstReads);
});

test('confirmed reward totals count only actual incoming ANTS transfers', async () => {
  const client = new ANTSTokenClient(config);
  const abi = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const transfer = (target: string, recipient: string, amount: bigint) => ({ address: target, ...abi.encodeEventLog(abi.getEvent('Transfer')!, [ZeroAddress, recipient, amount]) });
  Object.defineProperty(client, '_provider', { value: { getTransactionReceipt: async () => ({ status: 1, logs: [transfer(contractAddress, address, 12n), transfer(address, address, 99n), transfer(contractAddress, contractAddress, 30n)] }) } });
  assert.equal(await client.receivedInTransaction('confirmed', address), 12n);
});

test('reward receipt reads reject unavailable and failed transactions', async () => {
  const client = new ANTSTokenClient(config);
  let receipt: { status: number; logs: never[] } | null = null;
  Object.defineProperty(client, '_provider', { value: { getTransactionReceipt: async () => receipt } });
  await assert.rejects(client.receivedInTransaction('missing', address), /receipt unavailable/);
  receipt = { status: 0, logs: [] };
  await assert.rejects(client.receivedInTransaction('reverted', address), /receipt unavailable/);
});

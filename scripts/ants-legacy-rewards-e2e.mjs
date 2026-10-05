import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AbiCoder, Contract, ContractFactory, id, keccak256, parseUnits, toBeHex, ZeroAddress } from 'ethers';

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let compiled;

export function artifacts() {
  if (compiled) return compiled;
  const installed = path.join(homedir(), '.svm/0.8.24/solc-0.8.24');
  const compiler = process.env.SOLC_BIN || (existsSync(installed) ? installed : 'solc');
  const version = spawnSync(compiler, ['--version'], { encoding: 'utf8' });
  assert.match(version.stdout ?? '', /Version: 0\.8\.24\+/, 'Install Foundry solc 0.8.24 or set SOLC_BIN to that compiler');
  const selection = {
    'legacy/AntseedEmissions.sol': { AntseedEmissions: ['storageLayout'] },
    'legacy/AntseedEmissionsV2.sol': { AntseedEmissionsV2: ['storageLayout'] },
    'policies/AntseedSellerUnlockPolicy.sol': { AntseedSellerUnlockPolicy: ['abi', 'evm.bytecode.object'] },
    'policies/AntseedLegacySellerClaimPolicy.sol': { AntseedLegacySellerClaimPolicy: ['abi', 'evm.bytecode.object'] },
    'test/mocks/AntsRewardsSandbox.sol': { '*': ['abi', 'evm.bytecode.object'] },
  };
  const result = spawnSync(compiler, ['--standard-json', '--base-path', path.join(repository, 'packages/contracts'), '--include-path', path.join(repository, 'node_modules')], {
    input: JSON.stringify({ language: 'Solidity', sources: Object.fromEntries(Object.keys(selection).map(source => [source, { urls: [source] }])), settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, outputSelection: selection } }),
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 120000,
  });
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual((output.errors ?? []).filter(error => error.severity === 'error'), []);
  compiled = output.contracts;
  return compiled;
}

export async function runLegacyRewardScenarios({ isolate, api, action, open, provider, rpc, wallet, buyer, chain, getServer }) {
  assert(['127.0.0.1', 'localhost'].includes(new URL(chain.rpcUrl).hostname));
  assert.equal(await rpc('eth_chainId'), '0x7a69');
  assert.match(await rpc('web3_clientVersion'), /anvil/i);
  const token = new Contract(chain.antsTokenAddress, [
    'function owner() view returns(address)', 'function balanceOf(address) view returns(uint256)', 'function totalSupply() view returns(uint256)',
    'function transferWhitelist(address) view returns(bool)', 'function transfersEnabled() view returns(bool)',
    'function setTransferWhitelist(address,bool)', 'function enableTransfers()',
  ], provider);
  const refresh = () => api('wallet', { address: wallet, chainId: 31337, refresh: true });
  async function ownerSend(contract, method, values = []) {
    const owner = await contract.owner();
    await rpc('anvil_impersonateAccount', [owner]);
    try {
      await rpc('anvil_setBalance', [owner, '0x56BC75E2D63100000']);
      await (await contract.connect(await provider.getSigner(owner))[method](...values)).wait();
    } finally { await rpc('anvil_stopImpersonatingAccount', [owner]); }
  }
  async function deploy(source, name, values = []) {
    const artifact = artifacts()[source][name];
    const deployed = await new ContractFactory(artifact.abi, artifact.evm.bytecode.object, await provider.getSigner(wallet)).deploy(...values);
    await deployed.waitForDeployment();
    return deployed;
  }
  async function seed({ preMigration = false } = {}) {
    const stack = await getServer().context.stack();
    const legacy = new Contract(stack.legacyEmissions, [
      'function owner() view returns(address)', 'function MIGRATION_EPOCH() view returns(uint256)',
      'function legacyEmissions() view returns(address)',
      'function sellerRewardsPool() view returns(address)', 'function sellerUnlockPolicy() view returns(address)', 'function setSellerUnlockPolicy(address)',
      'function epochParams(uint256) view returns(uint256,uint256,uint256,uint256,uint256,uint256,bool)',
      'function epochTotalSellerPoints(uint256) view returns(uint256)', 'function epochTotalBuyerPoints(uint256) view returns(uint256)',
      'function userSellerPoints(address,uint256) view returns(uint256)', 'function userBuyerPoints(address,uint256) view returns(uint256)',
      'function sellerEpochClaimed(address,uint256) view returns(bool)', 'function buyerEpochClaimed(address,uint256) view returns(bool)',
    ], provider);
    const migrationEpoch = Number(await legacy.MIGRATION_EPOCH());
    const lastEpoch = stack.effectiveEpoch - 1;
    const epoch = preMigration ? migrationEpoch - 1 : lastEpoch;
    assert(lastEpoch > migrationEpoch && epoch >= 0, 'Seed a finalized legacy epoch before the recognized-usage boundary');
    const params = await legacy.epochParams(epoch);
    assert(params[6] && params[0] > 0n && params[1] > 0n, 'Pinned epoch must have real snapshotted reward budgets');
    const pointsContract = preMigration ? new Contract(await legacy.legacyEmissions(), legacy.interface, provider) : legacy;
    const layout = preMigration ? artifacts()['legacy/AntseedEmissions.sol'].AntseedEmissions.storageLayout.storage : artifacts()['legacy/AntseedEmissionsV2.sol'].AntseedEmissionsV2.storageLayout.storage;
    const mappingSlot = (label, keys) => {
      const field = layout.find(entry => entry.label === label);
      assert(field && field.offset === 0 && field.type.startsWith('t_mapping'), `Missing mapping layout: ${label}`);
      return keys.reduce((slot, [type, value]) => keccak256(AbiCoder.defaultAbiCoder().encode([type, 'uint256'], [value, slot])), BigInt(field.slot));
    };
    for (const [side, account] of [['Seller', wallet], ['Buyer', buyer]]) {
      const total = await pointsContract[`epochTotal${side}Points`](epoch);
      const totalSlot = mappingSlot(`epochTotal${side}Points`, [['uint256', epoch]]);
      const userSlot = mappingSlot(`user${side}Points`, [['address', account], ['uint256', epoch]]);
      assert.equal(BigInt(await provider.getStorage(pointsContract.target, totalSlot)), total, 'Compiled layout must match the fork before storage writes');
      assert.equal(await pointsContract[`user${side}Points`](account, epoch), 0n, 'Use fresh sandbox identities');
      const points = total / 100n + 1000n;
      await rpc('anvil_setStorageAt', [pointsContract.target, totalSlot, toBeHex(total + points, 32)]);
      await rpc('anvil_setStorageAt', [pointsContract.target, userSlot, toBeHex(points, 32)]);
      assert.equal(await pointsContract[`user${side}Points`](account, epoch), points);
      assert.equal(await pointsContract[`epochTotal${side}Points`](epoch), total + points);
    }
    const pool = new Contract(await legacy.sellerRewardsPool(), [
      'function owner() view returns(address)', 'function lockedRewards(address) view returns(uint256)', 'function totalLockedRewards() view returns(uint256)',
      'function sellerClaimPolicy() view returns(address)', 'function setSellerClaimPolicy(address)', 'function claim(address)',
    ], provider);
    await ownerSend(legacy, 'setSellerUnlockPolicy', [ZeroAddress]);
    await ownerSend(pool, 'setSellerClaimPolicy', [ZeroAddress]);
    await refresh();
    const before = await api('rewards');
    assert(BigInt(before.legacy.buyer) > 0n && BigInt(before.legacy.seller) > 0n);
    assert(BigInt(before.buyerUsage.total) > 0n && BigInt(before.sellerUsage.total) > 0n && BigInt(before.staker.total) > 0n);
    assert.equal(await token.transfersEnabled(), false);
    assert.equal(await token.transferWhitelist(wallet), false);
    return { legacy, pool, epoch, lastEpoch, before };
  }
  const unchangedCurrent = (after, before) => {
    for (const source of ['buyerUsage', 'sellerUsage', 'staker']) assert.equal(after[source].total, before[source].total, `${source} must remain untouched`);
  };
  async function installRelease(fixture, { whitelist = true, wash = false } = {}) {
    const status = await deploy('test/mocks/AntsRewardsSandbox.sol', 'AntsRewardsSandboxWashStatus');
    if (wash) await (await status.setWashTrader(wallet, true)).wait();
    const policy = await deploy('policies/AntseedLegacySellerClaimPolicy.sol', 'AntseedLegacySellerClaimPolicy', [fixture.legacy.target, fixture.lastEpoch, 1000, status.target]);
    await ownerSend(fixture.pool, 'setSellerClaimPolicy', [policy.target]);
    await ownerSend(token, 'setTransferWhitelist', [fixture.pool.target, whitelist]);
    await refresh();
    return policy;
  }
  async function claimLocked(fixture) {
    return action('rewards/claim', { buckets: ['legacy'], scope: 'wallet', expectedLegacySellerRecipient: fixture.pool.target });
  }

  for (const bucket of ['buyer', 'legacy']) await isolate(`legacy matrix: ${bucket === 'buyer' ? 'current' : 'legacy'} buyer claim is source-specific and repeat-safe`, async () => {
    const fixture = await seed();
    const balance = await token.balanceOf(wallet), buyerBalance = await token.balanceOf(buyer), supply = await token.totalSupply();
    const positions = await open();
    const result = await action('rewards/claim', { buckets: [bucket], scope: 'buyer' });
    const amount = BigInt(bucket === 'buyer' ? fixture.before.buyerUsage.total : fixture.before.legacy.buyer);
    assert.equal(await token.balanceOf(wallet) - balance, amount);
    assert.equal(result.result.claimed, amount.toString());
    assert.equal(await token.balanceOf(buyer), buyerBalance);
    const after = await api('rewards');
    assert.equal(after.legacy.seller, fixture.before.legacy.seller);
    assert.equal(after.sellerUsage.total, fixture.before.sellerUsage.total);
    assert.equal(after.staker.total, fixture.before.staker.total);
    assert.equal(after.buyerUsage.total, bucket === 'buyer' ? '0' : fixture.before.buyerUsage.total);
    assert.equal(after.legacy.buyer, bucket === 'legacy' ? '0' : fixture.before.legacy.buyer);
    assert.equal(await fixture.legacy.buyerEpochClaimed(buyer, fixture.epoch), bucket === 'legacy');
    if (bucket === 'legacy') assert.equal(await token.totalSupply(), supply, 'Legacy claims spend escrow; they do not mint supply');
    assert.deepEqual(await open(), positions);
    assert.equal((await action('rewards/claim', { buckets: [bucket], scope: 'buyer' })).approvals, 0);
  });

  await isolate('legacy matrix: combined buyer claim preserves seller rewards', async () => {
    const { before } = await seed();
    const balance = await token.balanceOf(wallet);
    await action('rewards/claim', { buckets: [], scope: 'buyer' });
    const after = await api('rewards');
    assert.equal(await token.balanceOf(wallet) - balance, BigInt(before.buyerUsage.total) + BigInt(before.legacy.buyer));
    assert.equal(after.buyerUsage.total, '0'); assert.equal(after.legacy.buyer, '0');
    assert.equal(after.legacy.seller, before.legacy.seller); assert.equal(after.sellerUsage.total, before.sellerUsage.total);
    assert.equal(after.staker.total, before.staker.total);
    assert.equal((await action('rewards/claim', { buckets: [], scope: 'buyer' })).approvals, 0);
  });

  for (const bucket of ['buyer', 'legacy']) await isolate(`legacy matrix: ${bucket} buyer authorization and rejection cause no state change`, async () => {
    const { before } = await seed();
    const balance = await token.balanceOf(wallet), nonce = await rpc('eth_getTransactionCount', [wallet, 'latest']);
    await assert.rejects(action('rewards/claim', { buckets: [bucket], scope: 'buyer' }, { reject: true }), /rejected/);
    await api('wallet', { address: buyer, chainId: 31337 });
    await assert.rejects(action('rewards/claim', { buckets: [bucket], scope: 'buyer' }), /authorized/);
    await refresh();
    assert.equal(await token.balanceOf(wallet), balance);
    assert.equal(await rpc('eth_getTransactionCount', [wallet, 'latest']), nonce);
    assert.deepEqual(await api('rewards'), before);
  });

  await isolate('legacy matrix: direct buyer staking excludes all legacy balances', async () => {
    const { before } = await seed();
    const balance = await token.balanceOf(wallet), positions = await open();
    await action('rewards/stake-usage', { side: 'buyer', epochs: 4, stakeAgentId: positions[0].agentId });
    const after = await api('rewards');
    assert.equal(after.buyerUsage.total, '0');
    assert.deepEqual(after.legacy, before.legacy);
    assert.equal(after.sellerUsage.total, before.sellerUsage.total);
    assert.equal(after.staker.total, before.staker.total);
    assert.equal(await token.balanceOf(wallet), balance);
    const created = (await open()).filter(position => !positions.some(previous => previous.id === position.id));
    assert.equal(created.reduce((total, position) => total + BigInt(position.amount), 0n), BigInt(before.buyerUsage.total));
    await assert.rejects(action('rewards/stake-usage', { side: 'buyer', epochs: 4, stakeAgentId: positions[0].agentId }), /No unclaimed/);
    assert.deepEqual((await api('rewards')).legacy, before.legacy);
  });

  for (const source of ['seller', 'staker']) await isolate(`legacy matrix: direct ${source} staking excludes legacy and other current rewards`, async () => {
    const { before } = await seed();
    const positions = await open(), balance = await token.balanceOf(wallet);
    const key = source === 'seller' ? 'sellerUsage' : 'staker';
    await action(source === 'seller' ? 'rewards/stake-usage' : 'rewards/restake', source === 'seller' ? { side: 'seller', epochs: 4 } : { epochs: 4 });
    const after = await api('rewards');
    assert.equal(after[key].total, '0');
    for (const other of ['buyerUsage', 'sellerUsage', 'staker'].filter(entry => entry !== key)) assert.equal(after[other].total, before[other].total);
    assert.deepEqual(after.legacy, before.legacy);
    assert.equal(await token.balanceOf(wallet), balance);
    const created = (await open()).filter(position => !positions.some(previous => previous.id === position.id));
    assert.equal(created.reduce((total, position) => total + BigInt(position.amount), 0n), BigInt(before[key].total));
    await assert.rejects(action(source === 'seller' ? 'rewards/stake-usage' : 'rewards/restake', source === 'seller' ? { side: 'seller', epochs: 4 } : { epochs: 4 }), /No unclaimed|No staker rewards/);
    assert.deepEqual((await api('rewards')).legacy, before.legacy);
  });

  for (const includeBuyer of [false, true]) await isolate(`legacy matrix: compound excludes legacy rewards (include buyer: ${includeBuyer})`, async () => {
    const { before } = await seed();
    const positions = await open(), balance = await token.balanceOf(wallet);
    await action('rewards/compound', { epochs: 4, includeBuyer, targetAgentId: positions[0].agentId });
    const after = await api('rewards');
    assert.equal(after.staker.total, '0'); assert.equal(after.sellerUsage.total, '0');
    assert.equal(after.buyerUsage.total, includeBuyer ? '0' : before.buyerUsage.total);
    assert.deepEqual(after.legacy, before.legacy);
    assert.equal(await token.balanceOf(wallet), balance);
    const added = BigInt(before.staker.total) + BigInt(before.sellerUsage.total) + (includeBuyer ? BigInt(before.buyerUsage.total) : 0n);
    assert.equal((await open()).reduce((total, position) => total + BigInt(position.amount), 0n) - positions.reduce((total, position) => total + BigInt(position.amount), 0n), added);
  });

  for (const permission of ['whitelist', 'global']) await isolate(`legacy matrix: claimed buyer rewards need wallet transfer permission (${permission})`, async () => {
    await seed();
    await action('rewards/claim', { buckets: ['legacy'], scope: 'buyer' });
    const positions = await open(), balance = await token.balanceOf(wallet);
    const request = { agentId: positions[0].agentId, amount: '1', epochs: 4 };
    await assert.rejects(action('positions/stake', request), /transfers are not enabled/);
    assert.equal(await token.balanceOf(wallet), balance); assert.deepEqual(await open(), positions);
    await ownerSend(token, permission === 'global' ? 'enableTransfers' : 'setTransferWhitelist', permission === 'global' ? [] : [wallet, true]);
    await refresh(); await action('positions/stake', request);
    assert.equal(balance - await token.balanceOf(wallet), parseUnits('1', 18));
    assert.equal((await open()).length, positions.length + 1);
  });

  await isolate('legacy matrix: seller claims enter the locked pool and missing M002 blocks release', async () => {
    const fixture = await seed();
    const balance = await token.balanceOf(wallet), poolBalance = await token.balanceOf(fixture.pool.target), supply = await token.totalSupply(), positions = await open();
    await claimLocked(fixture);
    const amount = BigInt(fixture.before.legacy.seller), after = await api('rewards');
    assert.equal(await fixture.pool.lockedRewards(wallet), amount);
    assert.equal(await token.balanceOf(fixture.pool.target) - poolBalance, amount);
    assert.equal(await token.balanceOf(wallet), balance); assert.equal(await token.totalSupply(), supply);
    assert.equal(after.legacy.seller, '0'); assert.equal(after.legacy.buyer, fixture.before.legacy.buyer);
    unchangedCurrent(after, fixture.before); assert.deepEqual(await open(), positions);
    assert.equal(after.locked.policy, null); assert.equal(after.locked.claimable, '0');
    assert.equal((await claimLocked(fixture)).approvals, 0);
    assert.equal((await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' })).approvals, 0);
    await assert.rejects(fixture.pool.connect(await provider.getSigner(wallet)).claim.staticCall(wallet), error => error.data === id('NoSellerClaimPolicy()').slice(0, 10));
  });

  await isolate('legacy matrix: eligible seller payout goes to wallet, not a stake', async () => {
    const fixture = await seed();
    const policy = await deploy('policies/AntseedSellerUnlockPolicy.sol', 'AntseedSellerUnlockPolicy');
    await (await policy.setSellerEligibility(wallet, true)).wait();
    await ownerSend(fixture.legacy, 'setSellerUnlockPolicy', [policy.target]); await refresh();
    assert.deepEqual((await api('rewards')).legacy.sellerPayout, { destination: 'wallet', recipient: wallet });
    const balance = await token.balanceOf(wallet), locked = await fixture.pool.lockedRewards(wallet), positions = await open();
    await action('rewards/claim', { buckets: ['legacy'], scope: 'wallet', expectedLegacySellerRecipient: wallet });
    assert.equal(await token.balanceOf(wallet) - balance, BigInt(fixture.before.legacy.seller));
    assert.equal(await fixture.pool.lockedRewards(wallet), locked); assert.deepEqual(await open(), positions);
    unchangedCurrent(await api('rewards'), fixture.before);
    assert.equal((await api('rewards')).legacy.buyer, fixture.before.legacy.buyer);
    await assert.rejects(action('positions/stake', { agentId: positions[0].agentId, amount: '1', epochs: 4 }), /transfers are not enabled/);
  });

  await isolate('legacy matrix: stale seller payout destination is rejected before wallet approval', async () => {
    const fixture = await seed();
    const policy = await deploy('policies/AntseedSellerUnlockPolicy.sol', 'AntseedSellerUnlockPolicy');
    await (await policy.setSellerEligibility(wallet, true)).wait();
    await ownerSend(fixture.legacy, 'setSellerUnlockPolicy', [policy.target]);
    const nonce = await rpc('eth_getTransactionCount', [wallet, 'latest']);
    await assert.rejects(claimLocked(fixture), /destination changed or could not be verified/);
    assert.equal(await api('wallet/request'), null);
    assert.equal(await rpc('eth_getTransactionCount', [wallet, 'latest']), nonce);
    assert.equal(await fixture.legacy.sellerEpochClaimed(wallet, fixture.epoch), false);
  });

  await isolate('legacy matrix: reverting seller unlock policy uses the contract locked fallback', async () => {
    const fixture = await seed();
    const policy = await deploy('test/mocks/AntsRewardsSandbox.sol', 'AntsRewardsSandboxRevertingUnlockPolicy');
    await ownerSend(fixture.legacy, 'setSellerUnlockPolicy', [policy.target]); await refresh();
    assert.deepEqual((await api('rewards')).legacy.sellerPayout, { destination: 'locked', recipient: fixture.pool.target });
    await claimLocked(fixture);
    assert.equal(await fixture.pool.lockedRewards(wallet), BigInt(fixture.before.legacy.seller));
  });

  await isolate('legacy matrix: unavailable payout RPC keeps balances visible and blocks the reviewed claim', async () => {
    const fixture = await seed();
    const shared = getServer().context.provider(), call = shared.call.bind(shared);
    const selector = fixture.legacy.interface.getFunction('sellerUnlockPolicy').selector;
    shared.call = async transaction => {
      if (transaction.data === selector) throw new Error('Sandbox eligibility RPC unavailable');
      return call(transaction);
    };
    try {
      await refresh();
      const unavailable = await api('rewards');
      assert.equal(unavailable.legacy.seller, fixture.before.legacy.seller);
      assert.deepEqual(unavailable.legacy.sellerPayout, { destination: 'unknown', recipient: null });
      await assert.rejects(claimLocked(fixture), /could not be verified/);
      assert.equal(await api('wallet/request'), null);
    } finally { shared.call = call; }
    await refresh();
    assert.equal((await api('rewards')).legacy.sellerPayout.destination, 'locked');
  });

  await isolate('legacy matrix: M002 releases once, leaves the rest locked, and does not grant wallet staking', async () => {
    const fixture = await seed(); await claimLocked(fixture);
    await installRelease(fixture, { whitelist: false });
    const balance = await token.balanceOf(wallet), original = await fixture.pool.lockedRewards(wallet), positions = await open();
    const entitled = original * 1000n / 10000n;
    assert.equal((await api('rewards')).locked.claimable, entitled.toString());
    await assert.rejects(fixture.pool.connect(await provider.getSigner(wallet)).claim.staticCall(wallet), error => error.data === id('TransfersNotEnabled()').slice(0, 10), 'The release policy alone cannot bypass pool transfer restrictions');
    await ownerSend(token, 'setTransferWhitelist', [fixture.pool.target, true]); await refresh();
    await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' });
    assert.equal(await token.balanceOf(wallet) - balance, entitled);
    assert.equal(await fixture.pool.lockedRewards(wallet), original - entitled);
    const after = await api('rewards');
    assert.equal(after.locked.locked, (original - entitled).toString()); assert.equal(after.locked.claimable, '0');
    unchangedCurrent(after, fixture.before); assert.equal(after.legacy.buyer, fixture.before.legacy.buyer);
    assert.deepEqual(await open(), positions);
    assert.equal((await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' })).approvals, 0);
    await assert.rejects(action('positions/stake', { agentId: positions[0].agentId, amount: '1', epochs: 4 }), /transfers are not enabled/);
    await ownerSend(token, 'setTransferWhitelist', [wallet, true]); await refresh();
    await action('positions/stake', { agentId: positions[0].agentId, amount: '1', epochs: 4 });
    assert.equal(await fixture.pool.lockedRewards(wallet), original - entitled);
    assert.equal((await open()).length, positions.length + 1);
  });

  await isolate('legacy matrix: M002 blocks a proven wash trader without consuming locked rewards', async () => {
    const fixture = await seed(); await claimLocked(fixture); await installRelease(fixture, { wash: true });
    const locked = await fixture.pool.lockedRewards(wallet), balance = await token.balanceOf(wallet);
    assert(locked > 0n); assert.equal((await api('rewards')).locked.claimable, '0');
    assert.equal((await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' })).approvals, 0);
    await assert.rejects(fixture.pool.connect(await provider.getSigner(wallet)).claim.staticCall(wallet), error => error.data === id('NothingToClaim()').slice(0, 10));
    assert.equal(await fixture.pool.lockedRewards(wallet), locked); assert.equal(await token.balanceOf(wallet), balance);
  });

  await isolate('legacy matrix: pre-migration V1 buyer rewards are claimed through V2 without touching current rewards', async () => {
    const fixture = await seed({ preMigration: true });
    const balance = await token.balanceOf(wallet);
    await action('rewards/claim', { buckets: ['legacy'], scope: 'buyer' });
    assert.equal(await token.balanceOf(wallet) - balance, BigInt(fixture.before.legacy.buyer));
    assert.equal(await fixture.legacy.buyerEpochClaimed(buyer, fixture.epoch), true);
    const after = await api('rewards');
    assert.equal(after.legacy.buyer, '0'); assert.equal(after.legacy.seller, fixture.before.legacy.seller);
    unchangedCurrent(after, fixture.before);
    assert.equal((await action('rewards/claim', { buckets: ['legacy'], scope: 'buyer' })).approvals, 0);
  });

  await isolate('legacy matrix: M002 includes pre-migration V1 seller rewards locked through V2', async () => {
    const fixture = await seed({ preMigration: true });
    await claimLocked(fixture);
    const policy = await installRelease(fixture);
    const locked = await fixture.pool.lockedRewards(wallet), balance = await token.balanceOf(wallet);
    assert.equal(await policy.cumulativeLocked(wallet), locked);
    assert.equal((await api('rewards')).locked.claimable, (locked / 10n).toString());
    await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' });
    assert.equal(await token.balanceOf(wallet) - balance, locked / 10n);
    assert.equal(await fixture.pool.lockedRewards(wallet), locked - locked / 10n);
    assert.equal((await action('rewards/claim', { buckets: ['locked'], scope: 'wallet' })).approvals, 0);
  });
}

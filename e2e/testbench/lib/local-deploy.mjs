// The local chain's contract deploy (`--chain local`): packages/contracts from source, at deterministic addresses on a
// fresh Anvil. `topology.chain.contracts` picks the layout: 'payments' is script/Deploy.s.sol alone, 'full' (default)
// adds the rest of the production stack (recognized usage, free usage, verification) with the deployment scripts.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { CONTRACT_LAYOUTS, DEFAULT_CONTRACT_LAYOUT } from './topology.mjs';

const require = createRequire(import.meta.url);
const { Contract, getCreateAddress, JsonRpcProvider, toBeHex } = require('ethers');

export const LOCAL_CHAIN_ID = 31337;
/** Anvil account 0: deploys and owns every local contract, as Deploy.s.sol's default. */
export const LOCAL_DEPLOYER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const LOCAL_DEPLOYER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
/** The registry team wallet and the verification bucket's first controller (anvil accounts 8 and 9): the emissions gate takes one minter per controller, and the deployer is already the protocol reserve. */
export const LOCAL_TEAM_WALLET = '0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f';
export const LOCAL_VERIFICATION_WALLET = '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720';
export { CONTRACT_LAYOUTS, DEFAULT_CONTRACT_LAYOUT };
/** AntseedEmissionsGate.ANTS_TOKEN: the gate hardcodes Base's ANTS token, so the full layout puts ANTS there too. */
export const MAINNET_ANTS_TOKEN = '0xa87EE81b2C0Bc659307ca2D9ffdC38514DD85263';

/**
 * Deployer nonce of every contract script/Deploy.s.sol creates (nonces 0-9; its wiring calls take 10-23). These are
 * the chain-config `base-local` addresses the stress harness and e2e scripts already use.
 */
export const PAYMENTS_NONCES = {
  usdcContractAddress: 0,
  identityRegistryAddress: 1,
  antsTokenAddress: 2,
  registryContractAddress: 3,
  stakingContractAddress: 4,
  depositsContractAddress: 5,
  channelsContractAddress: 6,
  statsContractAddress: 7,
  emissionsContractAddress: 8,
  depositRelayAddress: 9,
};

/**
 * The full layout's other contracts, by deployer nonce, after Deploy.s.sol: DeployLocalFull.s.sol run() (24-56),
 * M001 Cutover.s.sol (57-58), DeployFreeUsage.s.sol (59-60), M003 Deploy.s.sol (61-65), wireVerification() (66-67).
 * Keys ending in Address are chain-config fields; the others reach scenarios through tb.contracts only.
 */
export const FULL_NONCES = {
  washTradingBlockhashStore: 26,
  washTradingVerifier: 27,
  washTradingRegistryAddress: 28,
  emissionsGateAddress: 29,
  sellerPoolsAddress: 30,
  sellerRegistryAddress: 31,
  positionInitAddress: 34,
  usageAccountingAddress: 35,
  pointsPolicyRegistryAddress: 36,
  washTradingPointsPolicy: 37,
  sellerPoolsRewardsAddress: 40,
  usageRewardsAddress: 41,
  legacyEmissionsEscrowAddress: 45,
  freeUsageContractAddress: 59,
  verificationResultsAddress: 61,
  verificationContractAddress: 62,
  verificationPointsPolicy: 63,
};
/** Deployer nonce once each layout is deployed: the next deploy step must start exactly here. */
export const LAYOUT_END_NONCE = { payments: 24, full: 68 };

const WEEK = 604_800;
/**
 * How far before wall time the full layout's Anvil starts: the deploy warps into the gate's next epoch (up to a week)
 * and the seller stakes wait for activation (two epochs today). Starting this far back and setting the clock to wall
 * time after setup (alignChainClock) leaves the chain at wall time, as on Base, instead of weeks ahead of it.
 */
export const LOCAL_CLOCK_LEAD_SECONDS = 4 * WEEK;

/** Genesis timestamp for the local Anvil of a layout (`anvil --timestamp`), or null to start at wall time. */
export function localGenesisTimestamp(layout, nowMs = Date.now()) {
  return assertContractLayout(layout) === 'full' ? Math.floor(nowMs / 1000) - LOCAL_CLOCK_LEAD_SECONDS : null;
}

/** Moves the chain clock up to wall time when setup left it behind; never backwards. Returns the seconds moved. */
export async function alignChainClock(provider, nowMs = Date.now()) {
  const chainNow = Number((await provider.getBlock('latest')).timestamp);
  const wallNow = Math.floor(nowMs / 1000);
  if (chainNow >= wallNow) return 0;
  await provider.send('evm_setNextBlockTimestamp', [wallNow]);
  await provider.send('evm_mine', []);
  return wallNow - chainNow;
}

export function assertContractLayout(layout, label = 'chain.contracts') {
  if (!CONTRACT_LAYOUTS.includes(layout)) throw new Error(`${label} must be one of ${CONTRACT_LAYOUTS.join(', ')}`);
  return layout;
}

const at = (nonce) => getCreateAddress({ from: LOCAL_DEPLOYER, nonce });

/**
 * Every address of a local layout: { chain } holds the chain-config fields, { extra } the contracts no chain-config
 * field names. The full layout's ANTS token is the copy at MAINNET_ANTS_TOKEN; Deploy.s.sol's original stays at
 * nonce 2 as legacyAntsToken. On the full layout the registry's staking and emissions point at SellerRegistry and
 * UsageAccounting; stakingContractAddress and emissionsContractAddress keep naming Deploy.s.sol's legacy contracts,
 * which is how the node tells a recognized-usage registry from a legacy one (payments/contract-stack.ts).
 */
export function localLayout(layout = DEFAULT_CONTRACT_LAYOUT) {
  assertContractLayout(layout);
  const chain = Object.fromEntries(Object.entries(PAYMENTS_NONCES).map(([key, nonce]) => [key, at(nonce)]));
  const extra = {};
  if (layout === 'full') {
    extra.legacyAntsToken = chain.antsTokenAddress;
    chain.antsTokenAddress = MAINNET_ANTS_TOKEN;
    for (const [key, nonce] of Object.entries(FULL_NONCES)) (key.endsWith('Address') ? chain : extra)[key] = at(nonce);
  }
  return { chain, extra };
}

/** Chain-config fields only the full layout deploys: the payments layout's chain config leaves them out. */
export const FULL_ONLY_CHAIN_KEYS = Object.keys(FULL_NONCES).filter((key) => key.endsWith('Address'));

/**
 * The testbench chain config of a local layout, from the node's `base-local` preset. Fails when the preset and the
 * deploy scripts' deterministic addresses disagree. 'payments' drops the full layout's contracts, so no node is
 * handed an address without code; the ANTS token is then Deploy.s.sol's.
 */
export function localChainConfig(preset, layout = DEFAULT_CONTRACT_LAYOUT) {
  const expected = localLayout('full').chain;
  const mismatched = Object.entries(expected).filter(([key, address]) => preset[key]?.toLowerCase() !== address.toLowerCase());
  assert.equal(mismatched.length, 0, `chain-config base-local no longer matches the local deploy: ${mismatched.map(([key, address]) => `${key} is ${preset[key] ?? 'unset'}, deploy puts it at ${address}`).join('; ')}`);
  // As on Base after the M001 cutover (base-mainnet): staking/emissions name SellerRegistry/UsageAccounting and the
  // legacy fields Deploy.s.sol's contracts. The preset keeps the legacy meaning, which Deploy.s.sol-only chains need.
  if (assertContractLayout(layout) === 'full') {
    return {
      ...preset,
      stakingContractAddress: preset.sellerRegistryAddress,
      emissionsContractAddress: preset.usageAccountingAddress,
      legacyStakingContractAddress: preset.stakingContractAddress,
      legacyEmissionsContractAddress: preset.emissionsContractAddress,
    };
  }
  const config = { ...preset, ...localLayout('payments').chain };
  for (const key of FULL_ONLY_CHAIN_KEYS) delete config[key];
  delete config.recognizedUsage;
  return config;
}

/**
 * Every contract address of the testbench chain, for manifest.chain.contracts and tb.contracts: the chain config's
 * `*Address` fields (the `Address` suffix dropped) plus, on the local chain, the layout's contracts no chain-config
 * field names (development verifier, points policies, Deploy.s.sol's original ANTS token).
 */
export function chainContracts(chain, layout = null) {
  const contracts = {};
  for (const [key, value] of Object.entries(chain)) {
    if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) && /Address$/.test(key)) contracts[key.replace(/(ContractAddress|Address)$/, '')] = value;
  }
  return layout ? { ...contracts, ...localLayout(layout).extra } : contracts;
}

/** What the layout's registry must point at once it is deployed; checked after the deploy. */
export function expectedRegistryPointers(layout) {
  const { chain } = localLayout(layout);
  return {
    channels: chain.channelsContractAddress,
    deposits: chain.depositsContractAddress,
    stats: chain.statsContractAddress,
    identityRegistry: chain.identityRegistryAddress,
    antsToken: chain.antsTokenAddress,
    staking: layout === 'full' ? chain.sellerRegistryAddress : chain.stakingContractAddress,
    emissions: layout === 'full' ? chain.usageAccountingAddress : chain.emissionsContractAddress,
  };
}

const CONTRACTS_DIR = 'packages/contracts';
const SKIP_TESTS = ['--skip', 'test', '--skip', '*.t.sol'];

/**
 * Deploys packages/contracts onto a fresh local Anvil. `toolHome` is the real HOME forge needs for its solc cache;
 * `broadcastDir` keeps forge's broadcast files out of the worktree. Returns the per-step timings (ms) and addresses.
 */
export async function deployLocalStack({ repo, rpcUrl, env = process.env, layout = DEFAULT_CONTRACT_LAYOUT, logPath, broadcastDir, toolHome, log = () => {}, onSpawn = () => {} }) {
  assertContractLayout(layout);
  const logStream = createWriteStream(logPath, { flags: 'a' });
  const cwd = join(repo, CONTRACTS_DIR);
  const baseEnv = {
    ...env, ...(toolHome ? { HOME: toolHome } : {}), DEPLOYER_PRIVATE_KEY: LOCAL_DEPLOYER_KEY,
    FOUNDRY_BROADCAST: broadcastDir, FOUNDRY_DISABLE_NIGHTLY_WARNING: '1',
  };
  const timings = {};
  const forge = async (label, args, env = {}) => {
    const started = Date.now();
    logStream.write(`\n===== [testbench] ${label} =====\n`);
    const child = spawn('forge', args, { cwd, env: { ...baseEnv, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn(child); // the supervisor's reaper stops forge too if the supervisor dies
    child.stdout.pipe(logStream, { end: false });
    child.stderr.pipe(logStream, { end: false });
    const [code, signal] = await once(child, 'exit');
    if (code !== 0) throw new Error(`${label} failed with ${code ?? signal} (see logs/forge.log)${signal === 'SIGKILL' || code === 137 ? '; solc was likely killed for memory (via_ir needs ~6 GB)' : ''}`);
    timings[label] = Date.now() - started;
  };
  const script = (label, path, env, extra = []) => forge(label, ['script', path, '--rpc-url', rpcUrl, '--broadcast', '--private-key', LOCAL_DEPLOYER_KEY, ...SKIP_TESTS, ...extra], env);
  const provider = new JsonRpcProvider(rpcUrl, LOCAL_CHAIN_ID, { cacheTimeout: -1, batchMaxCount: 1, staticNetwork: true });
  provider.pollingInterval = 100;
  const nonce = () => provider.getTransactionCount(LOCAL_DEPLOYER, 'latest');
  const expectNonce = async (expected, after) => assert.equal(await nonce(), expected, `deployer nonce after ${after} is not ${expected}: the deploy scripts changed, update FULL_NONCES and chain-config base-local`);
  try {
    assert.equal(await nonce(), 0, 'The local deploy needs a fresh Anvil (deployer nonce 0)');
    // Compile only what the scripts need first: the full test suite under via_ir needs far more memory and time.
    await forge('forge build', ['build', ...SKIP_TESTS]);
    await script('Deploy.s.sol', 'script/Deploy.s.sol');
    await expectNonce(LAYOUT_END_NONCE.payments, 'Deploy.s.sol');
    const { chain, extra } = localLayout(layout);
    if (layout === 'full') {
      const paymentsChain = localLayout('payments').chain;
      await copyContract(provider, paymentsChain.antsTokenAddress, MAINNET_ANTS_TOKEN);
      const common = { ANTSEED_REGISTRY: chain.registryContractAddress, DEPLOYER: LOCAL_DEPLOYER };
      await script('DeployLocalFull.s.sol', 'script/DeployLocalFull.s.sol', { ...common, ANTS_TOKEN: MAINNET_ANTS_TOKEN, TEAM_WALLET: LOCAL_TEAM_WALLET, VERIFICATION_WALLET: LOCAL_VERIFICATION_WALLET });
      await expectNonce(57, 'DeployLocalFull.s.sol');
      const started = Date.now();
      const warped = await warpPastEffectiveEpoch(provider, chain.emissionsGateAddress);
      timings['warp to effective epoch'] = Date.now() - started;
      log(`Recognized-usage stack deployed; warped ${warped.seconds}s into effective epoch ${warped.effectiveEpoch} for the cutover`);
      await script('M001 Cutover.s.sol', 'script/migrations/M001RecognizedUsage/Cutover.s.sol', {
        ...common, REGISTRY_OWNER: LOCAL_DEPLOYER, USAGE_ACCOUNTING: chain.usageAccountingAddress, SELLER_REGISTRY: chain.sellerRegistryAddress,
        EXPECTED_LEGACY_EMISSIONS: chain.emissionsContractAddress, EXPECTED_LEGACY_STAKING: chain.stakingContractAddress,
        VERIFICATION_WALLET: LOCAL_VERIFICATION_WALLET, WASH_TRADING_POINTS_POLICY: extra.washTradingPointsPolicy,
        // The testnet path: no DIEM staking proxy to fund before the flip.
        DIEM_STAKING_PROXY: '0x0000000000000000000000000000000000000000',
      });
      await script('DeployFreeUsage.s.sol', 'script/DeployFreeUsage.s.sol', common);
      await expectNonce(FULL_NONCES.verificationResultsAddress, 'DeployFreeUsage.s.sol');
      await script('M003 Deploy.s.sol', 'script/migrations/M003VerificationRegistry/Deploy.s.sol', {
        ...common, EXPECTED_CHAIN_ID: String(LOCAL_CHAIN_ID), EXPECTED_IDENTITY_REGISTRY: chain.identityRegistryAddress,
        SELLER_POOLS: chain.sellerPoolsAddress, USAGE_ACCOUNTING: chain.usageAccountingAddress, POINTS_POLICY_REGISTRY: chain.pointsPolicyRegistryAddress,
        VERIFICATION_OWNER: LOCAL_DEPLOYER, VERIFICATION_DEPLOYMENT_NONCE: String(FULL_NONCES.verificationResultsAddress),
      });
      await script('DeployLocalFull.s.sol wireVerification', 'script/DeployLocalFull.s.sol', {
        EMISSIONS_GATE: chain.emissionsGateAddress, POINTS_POLICY_REGISTRY: chain.pointsPolicyRegistryAddress,
        VERIFICATION_RESULTS: chain.verificationResultsAddress, VERIFICATION_POINTS_POLICY: extra.verificationPointsPolicy,
      }, ['--sig', 'wireVerification()']);
      await expectNonce(LAYOUT_END_NONCE.full, 'wireVerification()');
    }
    await verifyLocalLayout(provider, layout);
    return { layout, timings, contracts: { ...chain, ...extra } };
  } finally {
    provider.destroy();
    logStream.end();
  }
}

/**
 * Puts a copy of a deployed contract at another address: runtime code and the first storage slots (enough for a
 * fresh ANTSToken: ERC20 name, symbol, supply, owner, registry and the transfer flag; its mappings are still empty).
 */
export async function copyContract(provider, from, to, slots = 16) {
  const code = await provider.getCode(from);
  assert.notEqual(code, '0x', `no contract at ${from} to copy`);
  await provider.send('anvil_setCode', [to, code]);
  for (let slot = 0; slot < slots; slot += 1) {
    const value = await provider.getStorage(from, slot);
    if (BigInt(value) !== 0n) await provider.send('anvil_setStorageAt', [to, toBeHex(slot, 32), value]);
  }
}

/** The gate's next epoch boundary, as M001's cutover waits for: the effective epoch must have started. */
export async function warpPastEffectiveEpoch(provider, gateAddress) {
  const gate = new Contract(gateAddress, ['function effectiveEpoch() view returns(uint256)', 'function genesis() view returns(uint256)', 'function epochDuration() view returns(uint256)'], provider);
  const [effectiveEpoch, genesis, duration] = await Promise.all([gate.effectiveEpoch(), gate.genesis(), gate.epochDuration()]);
  const target = genesis + effectiveEpoch * duration + 1n;
  const now = BigInt((await provider.getBlock('latest')).timestamp);
  const seconds = Number(target > now ? target - now : 0n);
  if (seconds > 0) await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
  return { effectiveEpoch: Number(effectiveEpoch), seconds };
}

/** Every layout address has code and the registry points where the layout says (the layout check at `up`). */
export async function verifyLocalLayout(provider, layout) {
  const { chain, extra } = localLayout(layout);
  const missing = [];
  for (const [key, address] of Object.entries({ ...chain, ...extra })) if ((await provider.getCode(address)) === '0x') missing.push(`${key} ${address}`);
  assert.equal(missing.length, 0, `no code at: ${missing.join(', ')}; the deploy scripts no longer match the local layout`);
  const pointers = expectedRegistryPointers(layout);
  const registry = new Contract(chain.registryContractAddress, Object.keys(pointers).map((name) => `function ${name}() view returns(address)`), provider);
  const wrong = [];
  for (const [name, address] of Object.entries(pointers)) {
    const actual = await registry[name]();
    if (actual.toLowerCase() !== address.toLowerCase()) wrong.push(`registry.${name}() is ${actual}, expected ${address}`);
  }
  assert.equal(wrong.length, 0, wrong.join('; '));
}

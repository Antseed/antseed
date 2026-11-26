import path from 'node:path';
import process from 'node:process';

import { impersonatedSend } from './runtime/anvil.mjs';
import { readJson } from './runtime/fsx.mjs';
import { sourceCommit } from './runtime/exec.mjs';
import { booleanValue, call, cast, chainId, sameAddress } from './runtime/chain.mjs';
import { requireEnvironment } from './runtime/env.mjs';
import { broadcastIsLive, broadcastPath, parseBroadcast, runForgeScript, simulationPath } from './runtime/foundry.mjs';
import { currentRelease, historyRecordExists, writeCurrent, writeHistoryRecord } from './runtime/ledger.mjs';
import { runMigration } from './runtime/runner.mjs';

/**
 * M004 — Legacy emissions lock.
 *
 * Pins the deployed AntseedEmissionsV2 to the ownerless
 * AntseedLegacyEmissionsRegistry (no Channels, so no new points; the escrow
 * still pays earned epochs), then renounces AntseedSellerUnlockPolicy,
 * AntseedSellerRewardsPool, AntseedEmissionsV2, the legacy AntseedEmissions V1
 * and AntseedLegacyEmissionsEscrow. After it, the legacy seller rewards, who
 * may claim them, and what is locked forever are final.
 *
 * Single phase, one signer, idempotent on chain. The deployed registry is
 * recorded under `004-legacy-emissions-lock` and folded into `current.json`.
 */

const M004_NETWORK = 'base-mainnet';
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const RELEASE = '004-legacy-emissions-lock';
export const SIGNERS = ['legacyOwner'];

const CONTRACT_NAMES = {
  AntseedLegacyEmissionsRegistry: 'legacyEmissionsRegistry',
};

// ---------------------------------------------------------------------------
// Pure state logic
// ---------------------------------------------------------------------------

const isZero = (address) => sameAddress(address, ZERO_ADDRESS);

/**
 * `ready`   V2 still reads the escrow as its registry, or some of the five
 *           contracts still have an owner.
 * `active`  V2 reads a registry with no Channels that pays from the escrow,
 *           and all five contracts are ownerless.
 * `invalid` anything else (paused V2, foreign registry, M002 not installed).
 */
export function classifyM004(observation) {
  const { expected, v2, pool, unlockPolicy, registry } = observation;
  if (!v2 || !pool || !unlockPolicy) return 'invalid';
  if (!sameAddress(observation.escrowLegacyEmissions, expected.legacyEmissions)) return 'invalid';
  if (isZero(pool.sellerClaimPolicy)) return 'invalid';
  const pinnedToEscrow = sameAddress(v2.registry, expected.legacyEmissionsEscrow);
  const pinnedToLock = isZero(registry.channels)
    && sameAddress(registry.antsToken, expected.legacyEmissionsEscrow)
    && sameAddress(registry.deposits, expected.deposits);
  if (!pinnedToEscrow && !pinnedToLock) return 'invalid';
  const renounced = [v2.owner, pool.owner, unlockPolicy.owner, observation.v1.owner, observation.escrowOwner].every(isZero);
  if (pinnedToLock && renounced) return 'active';
  if (v2.paused) return 'invalid';
  return 'ready';
}

export function validateM004Options(options) {
  if (options.network === M004_NETWORK) return;
  throw new Error('M004 supports Base mainnet --dry-run/--broadcast/--fork-test only');
}

export function validateM004Baseline(canonical) {
  const required = ['antsToken', 'deposits', 'legacyEmissions', 'legacyEmissionsEscrow', 'legacySellerClaimPolicy'];
  const missing = required.filter((name) => !canonical.contracts?.[name]?.address);
  if (missing.length) {
    throw new Error(`M004 ${canonical.network} deployment baseline is missing: ${missing.join(', ')} (run M002 first)`);
  }
}

/** M004-specific ledger invariants for the release it owns. */
export function recordErrors(record) {
  const errors = [];
  const address = /^0x[0-9a-fA-F]{40}$/;
  const configuration = record.verificationConfiguration;
  if (!configuration || typeof configuration !== 'object') return ['verificationConfiguration is required'];
  for (const key of ['legacyEmissionsV2', 'legacyEmissionsV1', 'legacyEmissionsRegistry', 'sellerRewardsPool', 'sellerUnlockPolicy', 'escrow', 'deposits']) {
    if (!address.test(configuration[key] ?? '')) errors.push(`verificationConfiguration.${key} must be an address`);
  }
  if (configuration.registryChannels !== ZERO_ADDRESS) {
    errors.push('verificationConfiguration.registryChannels must be the zero address');
  }
  for (const key of ['legacyEmissionsV2Owner', 'sellerRewardsPoolOwner', 'sellerUnlockPolicyOwner', 'legacyEmissionsV1Owner', 'escrowOwner']) {
    if (configuration[key] !== ZERO_ADDRESS) errors.push(`verificationConfiguration.${key} must be the zero address`);
  }
  if (!record.contracts?.legacyEmissionsRegistry?.address) {
    errors.push('contracts.legacyEmissionsRegistry is required');
  } else if (configuration.legacyEmissionsRegistry
    && !sameAddress(record.contracts.legacyEmissionsRegistry.address, configuration.legacyEmissionsRegistry)) {
    errors.push('contracts.legacyEmissionsRegistry must match verificationConfiguration.legacyEmissionsRegistry');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function expectedState(canonical) {
  const contracts = canonical.contracts;
  return {
    antsToken: contracts.antsToken.address,
    deposits: contracts.deposits.address,
    legacyEmissions: contracts.legacyEmissions.address,
    legacyEmissionsEscrow: contracts.legacyEmissionsEscrow.address,
  };
}

function readOrNull(rpcUrl, address, signature) {
  try {
    return call(rpcUrl, address, signature);
  } catch {
    return null;
  }
}

async function observeM004(context) {
  const { rpcUrl, expected } = context;
  const liveChainId = chainId(rpcUrl);
  if (liveChainId !== context.canonical.chainId) {
    throw new Error(`RPC chain ID ${liveChainId} does not match ${context.network} (${context.canonical.chainId})`);
  }
  const v2Address = expected.legacyEmissions;
  const registryAddress = call(rpcUrl, v2Address, 'registry()(address)');
  const poolAddress = call(rpcUrl, v2Address, 'sellerRewardsPool()(address)');
  const unlockPolicyAddress = call(rpcUrl, v2Address, 'sellerUnlockPolicy()(address)');
  const v1Address = call(rpcUrl, v2Address, 'legacyEmissions()(address)');
  const observation = {
    chainId: liveChainId,
    expected,
    escrowLegacyEmissions: call(rpcUrl, expected.legacyEmissionsEscrow, 'legacyEmissions()(address)'),
    escrowOwner: call(rpcUrl, expected.legacyEmissionsEscrow, 'owner()(address)'),
    v1: { address: v1Address, owner: call(rpcUrl, v1Address, 'owner()(address)') },
    v2: {
      address: v2Address,
      owner: call(rpcUrl, v2Address, 'owner()(address)'),
      paused: booleanValue(call(rpcUrl, v2Address, 'paused()(bool)')),
      registry: registryAddress,
    },
    registry: {
      address: registryAddress,
      channels: readOrNull(rpcUrl, registryAddress, 'channels()(address)'),
      antsToken: readOrNull(rpcUrl, registryAddress, 'antsToken()(address)'),
      deposits: readOrNull(rpcUrl, registryAddress, 'deposits()(address)'),
    },
    pool: isZero(poolAddress) ? null : {
      address: poolAddress,
      owner: call(rpcUrl, poolAddress, 'owner()(address)'),
      sellerClaimPolicy: call(rpcUrl, poolAddress, 'sellerClaimPolicy()(address)'),
    },
    unlockPolicy: isZero(unlockPolicyAddress) ? null : {
      address: unlockPolicyAddress,
      owner: call(rpcUrl, unlockPolicyAddress, 'owner()(address)'),
    },
  };
  observation.state = classifyM004(observation);
  return observation;
}

function printStatus(observation) {
  console.log(`M004 state: ${observation.state}`);
  console.log(`EmissionsV2:         ${observation.v2.address} (owner ${observation.v2.owner}, paused ${observation.v2.paused})`);
  console.log(`EmissionsV2 registry: ${observation.registry.address} (channels ${observation.registry.channels})`);
  if (observation.pool) console.log(`SellerRewardsPool:   ${observation.pool.address} (owner ${observation.pool.owner})`);
  if (observation.unlockPolicy) {
    console.log(`SellerUnlockPolicy:  ${observation.unlockPolicy.address} (owner ${observation.unlockPolicy.owner})`);
  }
  console.log(`EmissionsV1:         ${observation.v1.address} (owner ${observation.v1.owner})`);
  console.log(`Escrow:              ${observation.expected.legacyEmissionsEscrow} (owner ${observation.escrowOwner})`);
}

// ---------------------------------------------------------------------------
// Environment and signer roles
// ---------------------------------------------------------------------------

function liveOwner(observation) {
  return [observation.v2.owner, observation.pool?.owner, observation.unlockPolicy?.owner, observation.v1.owner, observation.escrowOwner]
    .find((owner) => owner && !isZero(owner)) ?? ZERO_ADDRESS;
}

function expectedSigner(role, context, observation) {
  if (role === 'legacyOwner') return liveOwner(observation);
  throw new Error(`Unknown signer role ${role}`);
}

function migrationEnvironment(context, observation, signerAddresses = {}, extra = {}) {
  return {
    ...process.env,
    ...(signerAddresses.legacyOwner ? { LEGACY_OWNER: signerAddresses.legacyOwner } : {}),
    BASE_MAINNET_RPC_URL: context.rpcUrl,
    LEGACY_EMISSIONS_V2: context.expected.legacyEmissions,
    LEGACY_EMISSIONS_ESCROW: context.expected.legacyEmissionsEscrow,
    EXPECTED_ANTS_TOKEN: context.expected.antsToken,
    EXPECTED_DEPOSITS: context.expected.deposits,
    ...extra,
  };
}

function verifyRoles(context, observation, env) {
  if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], env);
  requireEnvironment(['LEGACY_OWNER'], env);
  for (const [label, owner] of [
    ['EmissionsV2', observation.v2.owner],
    ['SellerRewardsPool', observation.pool.owner],
    ['SellerUnlockPolicy', observation.unlockPolicy.owner],
    ['EmissionsV1', observation.v1.owner],
    ['LegacyEmissionsEscrow', observation.escrowOwner],
  ]) {
    if (!isZero(owner) && !sameAddress(owner, env.LEGACY_OWNER)) {
      throw new Error(`legacyOwner (${env.LEGACY_OWNER}) is not the ${label} owner (${owner})`);
    }
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Recorded from chain state only. */
function verificationConfiguration(context, observation) {
  return {
    legacyEmissionsV2: observation.v2.address,
    legacyEmissionsRegistry: observation.registry.address,
    registryChannels: call(context.rpcUrl, observation.registry.address, 'channels()(address)'),
    escrow: call(context.rpcUrl, observation.registry.address, 'antsToken()(address)'),
    deposits: call(context.rpcUrl, observation.registry.address, 'deposits()(address)'),
    sellerRewardsPool: observation.pool.address,
    sellerUnlockPolicy: observation.unlockPolicy.address,
    legacyEmissionsV2Owner: observation.v2.owner,
    sellerRewardsPoolOwner: observation.pool.owner,
    sellerUnlockPolicyOwner: observation.unlockPolicy.owner,
    legacyEmissionsV1: observation.v1.address,
    legacyEmissionsV1Owner: observation.v1.owner,
    escrowOwner: observation.escrowOwner,
  };
}

async function recordRelease(context, observation) {
  const parsed = await parseBroadcast(broadcastPath('Lock.s.sol', context.canonical.chainId), context.rpcUrl, CONTRACT_NAMES);
  if (parsed.transactions.length === 0) throw new Error('Confirmed Foundry receipts are required to record M004');
  const contracts = parsed.contracts.legacyEmissionsRegistry
    ? parsed.contracts
    : { legacyEmissionsRegistry: { address: observation.registry.address, external: false, deployedInRelease: false } };
  if (!sameAddress(contracts.legacyEmissionsRegistry.address, observation.registry.address)) {
    throw new Error('The recorded AntseedLegacyEmissionsRegistry is not the registry EmissionsV2 reads');
  }
  const verification = verificationConfiguration(context, observation);
  const commit = sourceCommit();

  if (!(await historyRecordExists(context, RELEASE))) {
    await writeHistoryRecord(context, RELEASE, {
      $schema: '../../schema.json',
      network: context.network,
      chainId: context.canonical.chainId,
      release: RELEASE,
      status: 'active',
      sourceCommit: commit,
      transactions: parsed.transactions,
      verificationConfiguration: verification,
      contracts,
    });
  }
  if (await currentRelease(context) === RELEASE) return;

  const current = structuredClone(context.canonical);
  current.release = RELEASE;
  current.sourceCommit = commit;
  current.transactions = parsed.transactions;
  current.verificationConfiguration = verification;
  for (const contract of Object.values(current.contracts)) contract.deployedInRelease = false;
  Object.assign(current.contracts, contracts);
  for (const key of ['legacyEmissions', 'legacyEmissionsV1', 'legacyEmissionsEscrow']) {
    if (current.contracts[key]) current.contracts[key] = { ...current.contracts[key], owner: null };
  }
  await writeCurrent(context, current);
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

const lockPhase = {
  id: 'lock',
  guard: (observation) => observation.state === 'ready',
  signers: () => SIGNERS,
  plan: (context, observation) => ({
    release: RELEASE,
    phaseId: 'lock',
    simulationFile: simulationPath('Lock.s.sol', context.canonical.chainId),
    pointerChanges: {
      'AntseedEmissionsV2.registry': {
        before: observation.v2.registry,
        after: sameAddress(observation.v2.registry, context.expected.legacyEmissionsEscrow)
          ? 'AntseedLegacyEmissionsRegistry (deployed by this phase)'
          : observation.v2.registry,
      },
      'AntseedSellerUnlockPolicy.owner': { before: observation.unlockPolicy.owner, after: ZERO_ADDRESS },
      'AntseedSellerRewardsPool.owner': { before: observation.pool.owner, after: ZERO_ADDRESS },
      'AntseedEmissionsV2.owner': { before: observation.v2.owner, after: ZERO_ADDRESS },
      'AntseedEmissions (V1).owner': { before: observation.v1.owner, after: ZERO_ADDRESS },
      'AntseedLegacyEmissionsEscrow.owner': { before: observation.escrowOwner, after: ZERO_ADDRESS },
    },
  }),
  async run(context, mode, environment, observation, wallet) {
    runForgeScript({
      target: 'script/migrations/M004LegacyEmissionsLock/Lock.s.sol:M004LockLegacyEmissions',
      rpcUrl: context.rpcUrl,
      broadcast: mode === 'broadcast',
      verify: !context.forkTest,
      etherscanApiKey: environment.BASESCAN_API_KEY,
      env: environment,
      walletArgs: wallet.forgeArgs,
    });
    if (mode !== 'broadcast') return;
    const after = await observeM004(context);
    if (after.state !== 'active') throw new Error(`M004 broadcast finished but the lock is not active (${after.state})`);
    await recordRelease(context, after);
    console.log('M004 complete: legacy emissions are pinned and their owners renounced.');
  },
};

/** Writes the record when the lock landed but recording did not finish. */
async function finalize(context, observation, mode) {
  if (mode !== 'broadcast' || observation.state !== 'active') return false;
  const historyWritten = await historyRecordExists(context, RELEASE);
  const currentWritten = await currentRelease(context) === RELEASE;
  if (historyWritten && currentWritten) return false;
  if (!(await broadcastIsLive(broadcastPath('Lock.s.sol', context.canonical.chainId), context.rpcUrl))) {
    throw new Error('M004 is active on chain but no confirmed Lock.s.sol receipts are available to record it');
  }
  await recordRelease(context, observation);
  console.log(historyWritten
    ? 'Recovered M004 current.json from the confirmed history record.'
    : 'Recovered M004 records from confirmed Foundry receipts.');
  return true;
}

function idleMessage(observation) {
  if (observation.state === 'active') return 'M004 is already active; no transactions required.';
  return 'No M004 phase applies to the observed state.';
}

// ---------------------------------------------------------------------------
// Fork test
// ---------------------------------------------------------------------------

/**
 * The rehearsal fork predates M001, so earlier rehearsals may have moved the
 * pool to another Anvil account. Give all five contracts to V2's owner, as on
 * mainnet, then lock twice: once for real and once as a no-op.
 */
async function rehearse({ rpcUrl, outputRoot, network, runMigration: drive }) {
  const canonical = await readJson(path.join(outputRoot, network, 'current.json'));
  const legacyEmissions = canonical.contracts.legacyEmissions.address;
  const owner = call(rpcUrl, legacyEmissions, 'owner()(address)');
  const targets = ['sellerRewardsPool()(address)', 'sellerUnlockPolicy()(address)', 'legacyEmissions()(address)']
    .map((signature) => call(rpcUrl, legacyEmissions, signature));
  targets.push(canonical.contracts.legacyEmissionsEscrow.address);
  cast(rpcUrl, ['rpc', 'anvil_impersonateAccount', owner]);
  cast(rpcUrl, ['rpc', 'anvil_setBalance', owner, '0x3635C9ADC5DEA00000']);
  for (const target of targets) {
    const current = call(rpcUrl, target, 'owner()(address)');
    if (sameAddress(current, owner)) continue;
    impersonatedSend(rpcUrl, current, target, 'transferOwnership(address)', [owner]);
    // The escrow is Ownable2Step: the transfer is only pending until the new owner accepts.
    if (!sameAddress(call(rpcUrl, target, 'owner()(address)'), owner)) {
      cast(rpcUrl, ['send', target, 'acceptOwnership()', '--from', owner, '--unlocked']);
    }
  }

  const overrides = {
    environment: { ANTSEED_DEPLOY_CONFIRM: network },
    signers: { legacyOwner: `unlocked:${owner}` },
  };
  let observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error(`Expected M004 active, got ${observation.state}`);
  observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error('Repeated M004 broadcast was not an active no-op');
}

// ---------------------------------------------------------------------------
// Migration declaration
// ---------------------------------------------------------------------------

export const migration = {
  id: 'M004',
  networks: [M004_NETWORK],
  releases: [RELEASE],
  phases: [lockPhase],
  validateOptions: validateM004Options,
  validateBaseline: validateM004Baseline,
  expectedState,
  observe: observeM004,
  printStatus,
  environment: migrationEnvironment,
  verifyRoles,
  expectedSigner,
  finalize,
  idleMessage,
  recordErrors,
  allowedDirtyReleases: () => [],
  rehearsal: { prerequisites: ['M002'], run: rehearse },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

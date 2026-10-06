import process from 'node:process';

import { sourceCommit } from './runtime/exec.mjs';
import { booleanValue, call, chainId, hasCode, numberValue, sameAddress } from './runtime/chain.mjs';
import { requireEnvironment } from './runtime/env.mjs';
import { broadcastIsLive, broadcastPath, parseBroadcast, runForgeScript, simulationPath } from './runtime/foundry.mjs';
import { currentRelease, historyRecordExists, writeCurrent, writeHistoryRecord } from './runtime/ledger.mjs';
import { runMigration } from './runtime/runner.mjs';

/**
 * M002 — Legacy seller claims.
 *
 * Unfreezes the deployed AntseedSellerRewardsPool after M001 has activated:
 * whitelists the pool on ANTSToken (it is the transfer *sender* and was never
 * whitelisted) and installs AntseedLegacySellerClaimPolicy so sellers can
 * claim the released share of their locked legacy rewards. Proven wash
 * traders (per the wash-trading registry) can claim nothing.
 *
 * Single phase, two signers, fully idempotent on chain. The deployed policy is
 * recorded under `002-legacy-seller-claims` and folded into `current.json`.
 */

const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const M002_TESTNET = 'base-sepolia';
const M002_ANVIL_FORK = 'base-mainnet';

export const RELEASE = '002-legacy-seller-claims';
export const DEFAULT_RELEASE_BPS = 1000;
export const SIGNERS = ['deployer', 'sellerRewardsPoolOwner'];

const SIGNER_ENV = {
  deployer: 'DEPLOYER',
  sellerRewardsPoolOwner: 'SELLER_REWARDS_POOL_OWNER',
};

const CONTRACT_NAMES = {
  AntseedLegacySellerClaimPolicy: 'legacySellerClaimPolicy',
};

// ---------------------------------------------------------------------------
// Pure state logic
// ---------------------------------------------------------------------------

/**
 * `ready`          M001 is active, the pool exists, and at least one of the
 *                  two installs (whitelist, policy) is still missing.
 * `active`         pool can send ANTS and has the recorded claim policy.
 * `not-applicable` the legacy emissions contract has no rewards pool
 *                  (V1-only testnets); nothing to unfreeze.
 * `invalid`        anything else (M001 not active, foreign policy, ...).
 */
export function classifyM002(observation) {
  const { expected, registry } = observation;
  if (!sameAddress(registry.antsToken, expected.antsToken)) return 'invalid';
  if (!sameAddress(registry.emissions, expected.usageAccounting)) return 'invalid';
  if (!observation.legacyEmissionsV2) return 'invalid';
  if (!observation.pool) return 'not-applicable';
  if (!observation.lastLockedEpochValid) return 'invalid';
  const policy = observation.pool.sellerClaimPolicy;
  const hasPolicy = policy && !/^0x0{40}$/.test(policy);
  if (hasPolicy && !observation.pool.policyMatchesRecord) return 'invalid';
  const canTransfer = observation.token.transfersEnabled || observation.token.poolWhitelisted;
  if (hasPolicy && canTransfer) return 'active';
  return 'ready';
}

export function validateM002Options(options) {
  const testnetRun = options.network === M002_TESTNET && options.mode !== 'fork-test';
  const mainnetRun = options.network === M002_ANVIL_FORK;
  if (testnetRun || mainnetRun) return;
  throw new Error(
    'M002 supports Base Sepolia --dry-run/--broadcast and Base mainnet --dry-run/--broadcast/--fork-test',
  );
}

/**
 * M002 runs on top of an activated M001 ledger: `emissions` must already be
 * UsageAccounting. The V2 contract that locked rewards into the pool is read
 * on chain from the M001 escrow (`legacyEmissionsEscrow.legacyEmissions()`).
 */
export function validateM002Baseline(canonical) {
  const required = ['registry', 'antsToken', 'emissions', 'usageAccounting', 'washTradingRegistry', 'legacyEmissionsEscrow'];
  const missing = required.filter((name) => !canonical.contracts?.[name]?.address);
  if (missing.length) {
    throw new Error(`M002 ${canonical.network} deployment baseline is missing: ${missing.join(', ')}`);
  }
  if (!sameAddress(canonical.contracts.emissions.address, canonical.contracts.usageAccounting.address)) {
    throw new Error(`M002 ${canonical.network} baseline: emissions must already be AntseedUsageAccounting (run M001 first)`);
  }
}

/** M002-specific ledger invariants for the release it owns. */
export function recordErrors(record) {
  const errors = [];
  const address = /^0x[0-9a-fA-F]{40}$/;
  const configuration = record.verificationConfiguration;
  if (!configuration || typeof configuration !== 'object') return ['verificationConfiguration is required'];
  const expect = (key, ok, description) => {
    if (!ok(configuration[key])) errors.push(`verificationConfiguration.${key} must be ${description}`);
  };
  expect('sellerRewardsPool', (value) => address.test(value ?? ''), 'an address');
  expect('sellerClaimPolicy', (value) => address.test(value ?? ''), 'an address');
  expect('poolCanTransfer', (value) => value === true, 'true');
  expect('lastLockedEpoch', (value) => Number.isInteger(value) && value >= 0, 'a non-negative integer');
  expect('releaseBps', (value) => Number.isInteger(value) && value > 0 && value <= 10_000, 'an integer in (0, 10000]');
  expect('washTradingRegistry', (value) => address.test(value ?? ''), 'an address');
  if (!record.contracts?.legacySellerClaimPolicy?.address) {
    errors.push('contracts.legacySellerClaimPolicy is required');
  } else if (configuration.sellerClaimPolicy
    && !sameAddress(record.contracts.legacySellerClaimPolicy.address, configuration.sellerClaimPolicy)) {
    errors.push('contracts.legacySellerClaimPolicy must match verificationConfiguration.sellerClaimPolicy');
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function expectedState(canonical) {
  const contracts = canonical.contracts;
  return {
    registry: contracts.registry.address,
    antsToken: contracts.antsToken.address,
    usageAccounting: contracts.usageAccounting.address,
    legacyEmissionsEscrow: contracts.legacyEmissionsEscrow.address,
    washTradingRegistry: contracts.washTradingRegistry.address,
    recordedPolicy: contracts.legacySellerClaimPolicy?.address ?? null,
  };
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** V1-only legacy contracts (testnets) have no MIGRATION_EPOCH and no pool. */
function readMigrationEpoch(rpcUrl, legacyEmissionsV2) {
  try {
    return numberValue(call(rpcUrl, legacyEmissionsV2, 'MIGRATION_EPOCH()(uint256)'));
  } catch {
    return null;
  }
}

function readPool(rpcUrl, legacyEmissionsV2) {
  let pool;
  try {
    pool = call(rpcUrl, legacyEmissionsV2, 'sellerRewardsPool()(address)');
  } catch {
    return null;
  }
  if (!pool || sameAddress(pool, ZERO_ADDRESS) || !hasCode(rpcUrl, pool)) return null;
  return {
    address: pool,
    owner: call(rpcUrl, pool, 'owner()(address)'),
    sellerClaimPolicy: call(rpcUrl, pool, 'sellerClaimPolicy()(address)'),
    totalLockedRewards: call(rpcUrl, pool, 'totalLockedRewards()(uint256)').split(/\s/)[0],
  };
}

async function observeM002(context) {
  const { rpcUrl, expected } = context;
  const liveChainId = chainId(rpcUrl);
  if (liveChainId !== context.canonical.chainId) {
    throw new Error(`RPC chain ID ${liveChainId} does not match ${context.network} (${context.canonical.chainId})`);
  }
  // The V2 contract that locked rewards into the pool is pinned in the M001 escrow.
  const legacyEmissionsV2 = call(rpcUrl, expected.legacyEmissionsEscrow, 'legacyEmissions()(address)');
  const pool = readPool(rpcUrl, legacyEmissionsV2);
  const gate = call(rpcUrl, expected.usageAccounting, 'emissionsGate()(address)');
  const effectiveEpoch = numberValue(call(rpcUrl, gate, 'effectiveEpoch()(uint256)'));
  const migrationEpoch = readMigrationEpoch(rpcUrl, legacyEmissionsV2);
  const lastLockedEpoch = effectiveEpoch - 1;
  const observation = {
    chainId: liveChainId,
    expected,
    registry: {
      antsToken: call(rpcUrl, expected.registry, 'antsToken()(address)'),
      emissions: call(rpcUrl, expected.registry, 'emissions()(address)'),
    },
    legacyEmissionsV2: hasCode(rpcUrl, legacyEmissionsV2) ? legacyEmissionsV2 : null,
    token: {
      owner: call(rpcUrl, expected.antsToken, 'owner()(address)'),
      transfersEnabled: booleanValue(call(rpcUrl, expected.antsToken, 'transfersEnabled()(bool)')),
      poolWhitelisted: pool
        ? booleanValue(call(rpcUrl, expected.antsToken, 'transferWhitelist(address)(bool)', [pool.address]))
        : false,
    },
    pool: pool && {
      ...pool,
      // A policy that is not the one this ledger recorded is somebody else's install.
      policyMatchesRecord: expected.recordedPolicy
        ? sameAddress(pool.sellerClaimPolicy, expected.recordedPolicy)
        : sameAddress(pool.sellerClaimPolicy, ZERO_ADDRESS) || await policyIsOurs(context, pool.sellerClaimPolicy),
    },
    effectiveEpoch,
    migrationEpoch,
    lastLockedEpoch,
    lastLockedEpochValid: effectiveEpoch > 0 && migrationEpoch !== null && lastLockedEpoch >= migrationEpoch,
    washTradingRegistry: expected.washTradingRegistry,
  };
  observation.state = classifyM002(observation);
  return observation;
}

/**
 * When the ledger has no record yet but the pool already has a policy, accept
 * it only if our own confirmed broadcast produced it (a crash after sending
 * but before recording). Anything else is a foreign install.
 */
async function policyIsOurs(context, policy) {
  const broadcastFile = broadcastPath('Install.s.sol', context.canonical.chainId);
  if (!(await broadcastIsLive(broadcastFile, context.rpcUrl))) return false;
  const parsed = await parseBroadcast(broadcastFile, context.rpcUrl, CONTRACT_NAMES);
  return sameAddress(parsed.contracts.legacySellerClaimPolicy?.address, policy);
}

function printStatus(observation) {
  console.log(`M002 state: ${observation.state}`);
  console.log(`Registry emissions:  ${observation.registry.emissions}`);
  if (observation.pool) {
    console.log(`SellerRewardsPool:   ${observation.pool.address} (locked ${observation.pool.totalLockedRewards})`);
    console.log(`Pool claim policy:   ${observation.pool.sellerClaimPolicy}`);
    console.log(`Pool can transfer:   ${observation.token.transfersEnabled || observation.token.poolWhitelisted}`);
  } else {
    console.log('SellerRewardsPool:   none on the legacy emissions contract');
  }
  console.log(`Last locked epoch:   ${observation.lastLockedEpoch} (migration ${observation.migrationEpoch}, effective ${observation.effectiveEpoch})`);
  console.log(`Wash registry:       ${observation.washTradingRegistry}`);
}

// ---------------------------------------------------------------------------
// Environment and signer roles
// ---------------------------------------------------------------------------

function expectedSigner(role, context, observation) {
  switch (role) {
    case 'deployer': return observation.token.owner;
    case 'sellerRewardsPoolOwner': return observation.pool?.owner ?? ZERO_ADDRESS;
    default: throw new Error(`Unknown signer role ${role}`);
  }
}

/**
 * Environment handed to Install.s.sol. Signer roles arrive as addresses only.
 * The wash-trading registry defaults to the activated M001 deployment ledger;
 * `WASH_TRADING_REGISTRY` overrides it.
 */
function migrationEnvironment(context, observation, signerAddresses = {}, extra = {}) {
  return {
    ...process.env,
    ...Object.fromEntries(
      Object.entries(signerAddresses).filter(([role]) => SIGNER_ENV[role]).map(([role, address]) => [SIGNER_ENV[role], address]),
    ),
    BASE_MAINNET_RPC_URL: context.rpcUrl,
    BASE_SEPOLIA_RPC_URL: context.rpcUrl,
    ANTSEED_REGISTRY: context.expected.registry,
    EXPECTED_ANTS_TOKEN: context.expected.antsToken,
    LEGACY_EMISSIONS_V2: observation.legacyEmissionsV2,
    USAGE_ACCOUNTING: context.expected.usageAccounting,
    WASH_TRADING_REGISTRY: process.env.WASH_TRADING_REGISTRY ?? observation.washTradingRegistry,
    RELEASE_BPS: process.env.RELEASE_BPS ?? String(DEFAULT_RELEASE_BPS),
    ...extra,
  };
}

function verifyRoles(context, observation, env) {
  if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], env);
  requireEnvironment(['WASH_TRADING_REGISTRY'], env);
  if (!hasCode(context.rpcUrl, env.WASH_TRADING_REGISTRY)) {
    throw new Error('WASH_TRADING_REGISTRY has no code on this network');
  }
  const mustBe = (role, actual, label) => {
    requireEnvironment([SIGNER_ENV[role]], env);
    if (!sameAddress(actual, env[SIGNER_ENV[role]])) {
      throw new Error(`${role} (${env[SIGNER_ENV[role]]}) is not the ${label} owner`);
    }
  };
  const needsWhitelist = !observation.token.transfersEnabled && !observation.token.poolWhitelisted;
  if (needsWhitelist) mustBe('deployer', observation.token.owner, 'ANTSToken');
  mustBe('sellerRewardsPoolOwner', observation.pool.owner, 'seller rewards pool');
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** Recorded from chain state only. */
function verificationConfiguration(context, observation, policy) {
  const { rpcUrl } = context;
  const pool = observation.pool.address;
  return {
    sellerRewardsPool: pool,
    sellerClaimPolicy: policy,
    poolCanTransfer: booleanValue(call(rpcUrl, context.expected.antsToken, 'transfersEnabled()(bool)'))
      || booleanValue(call(rpcUrl, context.expected.antsToken, 'transferWhitelist(address)(bool)', [pool])),
    lastLockedEpoch: numberValue(call(rpcUrl, policy, 'lastEpoch()(uint256)')),
    releaseBps: numberValue(call(rpcUrl, policy, 'releaseBps()(uint256)')),
    washTradingRegistry: call(rpcUrl, policy, 'washTradingRegistry()(address)'),
  };
}

async function recordRelease(context, observation) {
  const parsed = await parseBroadcast(broadcastPath('Install.s.sol', context.canonical.chainId), context.rpcUrl, CONTRACT_NAMES);
  const policy = parsed.contracts.legacySellerClaimPolicy?.address ?? observation.pool.sellerClaimPolicy;
  if (!policy || sameAddress(policy, ZERO_ADDRESS)) throw new Error('No AntseedLegacySellerClaimPolicy found to record');
  if (parsed.transactions.length === 0) throw new Error('Confirmed Foundry receipts are required to record M002');
  const contracts = parsed.contracts.legacySellerClaimPolicy
    ? parsed.contracts
    : { legacySellerClaimPolicy: { address: policy, external: false, deployedInRelease: false } };
  const verification = verificationConfiguration(context, observation, policy);
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
  await writeCurrent(context, current);
}

// ---------------------------------------------------------------------------
// Phase
// ---------------------------------------------------------------------------

const installPhase = {
  id: 'install',
  guard: (observation) => observation.state === 'ready',
  signers: () => SIGNERS,
  plan: (context, observation) => ({
    release: RELEASE,
    phaseId: 'install',
    simulationFile: simulationPath('Install.s.sol', context.canonical.chainId),
    pointerChanges: {
      'ANTSToken.transferWhitelist(SellerRewardsPool)': {
        before: String(observation.token.poolWhitelisted),
        after: observation.token.transfersEnabled ? String(observation.token.poolWhitelisted) : 'true',
      },
      'SellerRewardsPool.sellerClaimPolicy': {
        before: observation.pool.sellerClaimPolicy,
        after: sameAddress(observation.pool.sellerClaimPolicy, ZERO_ADDRESS)
          ? 'AntseedLegacySellerClaimPolicy (deployed by this phase)'
          : observation.pool.sellerClaimPolicy,
      },
    },
  }),
  async run(context, mode, environment, observation, wallet) {
    runForgeScript({
      target: 'script/migrations/M002LegacySellerClaims/Install.s.sol:M002InstallLegacySellerClaims',
      rpcUrl: context.rpcUrl,
      broadcast: mode === 'broadcast',
      verify: !context.forkTest,
      etherscanApiKey: environment.BASESCAN_API_KEY,
      env: environment,
      walletArgs: wallet.forgeArgs,
    });
    if (mode !== 'broadcast') return;
    const after = await observeM002(context);
    if (after.state !== 'active') throw new Error(`M002 broadcast finished but the pool is not active (${after.state})`);
    await recordRelease(context, after);
    console.log('M002 complete: legacy sellers can claim from the rewards pool.');
  },
};

/** Writes the record when the install landed but recording did not finish. */
async function finalize(context, observation, mode) {
  if (mode !== 'broadcast' || observation.state !== 'active') return false;
  const historyWritten = await historyRecordExists(context, RELEASE);
  const currentWritten = await currentRelease(context) === RELEASE;
  if (historyWritten && currentWritten) return false;
  if (!(await broadcastIsLive(broadcastPath('Install.s.sol', context.canonical.chainId), context.rpcUrl))) {
    throw new Error('M002 is active on chain but no confirmed Install.s.sol receipts are available to record it');
  }
  await recordRelease(context, observation);
  console.log(historyWritten
    ? 'Recovered M002 current.json from the confirmed history record.'
    : 'Recovered M002 records from confirmed Foundry receipts.');
  return true;
}

function idleMessage(observation) {
  if (observation.state === 'active') return 'M002 is already active; no transactions required.';
  if (observation.state === 'not-applicable') {
    return 'The legacy emissions contract has no seller rewards pool on this network; M002 has nothing to do.';
  }
  return 'No M002 phase applies to the observed state.';
}

// ---------------------------------------------------------------------------
// Fork test
// ---------------------------------------------------------------------------

async function rehearse({ network, runMigration: drive }) {
  const overrides = {
    environment: { ANTSEED_DEPLOY_CONFIRM: network },
    signers: {
      deployer: `unlocked:${ANVIL_ACCOUNT_0}`,
      sellerRewardsPoolOwner: `unlocked:${ANVIL_ACCOUNT_1}`,
    },
  };
  let observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error(`Expected M002 active, got ${observation.state}`);
  observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error('Repeated M002 broadcast was not an active no-op');
}

// ---------------------------------------------------------------------------
// Migration declaration
// ---------------------------------------------------------------------------

export const migration = {
  id: 'M002',
  networks: [M002_TESTNET, M002_ANVIL_FORK],
  releases: [RELEASE],
  phases: [installPhase],
  validateOptions: validateM002Options,
  validateBaseline: validateM002Baseline,
  expectedState,
  observe: observeM002,
  printStatus,
  environment: migrationEnvironment,
  verifyRoles,
  expectedSigner,
  finalize,
  idleMessage,
  recordErrors,
  allowedDirtyReleases: () => [],
  rehearsal: { prerequisites: ['M001'], run: rehearse },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

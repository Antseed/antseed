import path from 'node:path';
import { capture, sourceCommit } from './runtime/exec.mjs';
import { booleanValue, call, callJson, cast, chainId, hasCode, numberValue, sameAddress } from './runtime/chain.mjs';
import { requireEnvironment } from './runtime/env.mjs';
import { fileExists } from './runtime/fsx.mjs';
import {
  broadcastIsLive, broadcastPath, mergeBroadcast, parseBroadcast, readReceiptFile, receiptFileIsLive,
  runForgeScript, simulationPath,
} from './runtime/foundry.mjs';
import {
  applyContractAliases, assertCheckpointBytecode, buildReleaseRecord, currentRelease, historyRecordExists, loadContext,
  readCheckpoint, writeActivationRecords, writeCheckpoint, writeHistoryRecord,
} from './runtime/ledger.mjs';
import { assertSignerOwners, signerEnvironment } from './runtime/signers.mjs';
import { runMigration } from './runtime/runner.mjs';
import { runCutover } from './m001-cutover.mjs';
import { advanceTimeTo, impersonatedSend } from './runtime/anvil.mjs';

const VERIFICATION_MINTER_ID = '0xd8018a5ea0ce31650e6d51e87c96f1d258a180b37e42ce66e7adf1c8ac666b57';
// --fork-test rehearsal fixtures (Base mainnet only).
export const BASE_MAINNET_FORK_BLOCK = 50_571_469;
export const BASE_MAINNET_DIEM_PROXY = '0x1f228613116E2d08014DfdCC198377C8dedf18C9';
// An account with DIEM staked on the proxy at the fork block; impersonated to
// fund the pre-cutover reward epoch so Cutover.s.sol exercises its
// "already funded" path exactly as it will on mainnet.
export const BASE_MAINNET_DIEM_STAKER = '0x48F4142F4AbF7b77a03f0cDffcd511eDD9B6d54a';
const M001_TESTNET = 'base-sepolia';
const M001_ANVIL_FORK = 'base-mainnet';

const DEPLOYED_RELEASE = '001-recognized-usage-deployed';
const ACTIVATED_RELEASE = '001-recognized-usage-activated';

const DEPLOYED_CONTRACT_NAMES = {
  AntseedEmissionsGate: 'emissionsGate',
  AntseedSellerPools: 'sellerPools',
  AntseedSellerRegistry: 'sellerRegistry',
  AntseedPositionInit: 'positionInit',
  AntseedWashTradingRegistry: 'washTradingRegistry',
  AntseedWashTradingPointsPolicy: 'washTradingPointsPolicy',
  AntseedUsageAccounting: 'usageAccounting',
  AntseedPointsPolicyRegistry: 'pointsPolicyRegistry',
  AntseedSellerPoolsRewards: 'sellerPoolsRewards',
  AntseedUsageRewards: 'usageRewards',
  AntseedLegacyEmissionsEscrow: 'legacyEmissionsEscrow',
  AntseedLegacyRewardsPoolRegistry: 'legacyRewardsPoolRegistry',
};

const REQUIRED_DEPLOYED_CONTRACTS = [
  'usageAccounting', 'sellerRegistry', 'emissionsGate', 'pointsPolicyRegistry', 'positionInit', 'washTradingRegistry',
  'washTradingPointsPolicy',
];
const CONTRACT_ALIASES = { emissions: 'usageAccounting', staking: 'sellerRegistry' };

const DEPLOY_SIGNERS = ['deployer'];
const CUTOVER_SIGNERS = ['registryOwner', 'channelsOwner', 'deployer'];
const CUTOVER_PROXY_SIGNERS = ['diemStaker', 'sellerRewardsPoolOwner'];

const SIGNER_ENV = {
  deployer: 'DEPLOYER',
  registryOwner: 'REGISTRY_OWNER',
  channelsOwner: 'CHANNELS_OWNER',
  diemStaker: 'DIEM_STAKER',
  sellerRewardsPoolOwner: 'SELLER_REWARDS_POOL_OWNER',
};

const deployPhase = {
  id: 'deploy',
  guard: (observation) => observation.state === 'ready',
  signers: () => DEPLOY_SIGNERS,
  plan: (context) => ({
    release: DEPLOYED_RELEASE,
    phaseId: 'deploy',
    simulationFile: simulationPath('Deploy.s.sol', context.canonical.chainId),
    pointerChanges: {
      'ANTSToken.registry': { before: context.expected.registry, after: 'AntseedEmissionsGate (deployed by this phase)' },
      'legacyEmissions.registry': { before: context.expected.registry, after: 'AntseedLegacyEmissionsEscrow (deployed by this phase)' },
    },
  }),
  run: deploy,
};

const cutoverPhase = {
  id: 'cutover',
  guard: (observation) => shouldRunM001Cutover(observation.state),
  signers: (_observation, context) => cutoverSigners(context),
  plan: (context, observation, runResult) => ({
    release: ACTIVATED_RELEASE,
    phaseId: 'cutover',
    simulationFile: runResult?.simulationFile
      ?? simulationPath('Cutover.s.sol', context.canonical.chainId),
    beforeTransactions: runResult?.beforeTransactions ?? [],
    afterTransactions: runResult?.afterTransactions ?? [],
    pointerChanges: {
      'registry.emissions': {
        before: observation.registry.emissions,
        after: observation.deployment?.checkpoint?.contracts?.usageAccounting?.address ?? null,
      },
      'registry.staking': {
        before: observation.registry.staking,
        after: observation.deployment?.checkpoint?.contracts?.sellerRegistry?.address ?? null,
      },
    },
  }),
  announce: (observation, mode) => {
    if (observation.state !== 'awaiting-epoch') return null;
    return mode === 'broadcast'
      ? 'The existing cutover scheduler will pause Channels before the epoch boundary and wait to continue.'
      : 'The effective epoch has not started; simulating the cutover now so its plan can be reviewed before the boundary.';
  },
  async preflight(context, observation) {
    if (!observation.channelsPaused || !observation.deployment) return;
    const pauseReceipt = path.join(context.receiptDirectory, 'pause.json');
    if (!(await receiptFileIsLive(pauseReceipt, context.rpcUrl))) {
      throw new Error('Channels is paused without a confirmed M001 pause receipt; refusing to adopt the pause');
    }
  },
  run: cutover,
};

export const migration = {
  id: 'M001',
  networks: [M001_TESTNET, M001_ANVIL_FORK],
  releases: [DEPLOYED_RELEASE, ACTIVATED_RELEASE],
  phases: [deployPhase, cutoverPhase],
  validateOptions: validateM001Options,
  validateBaseline: validateM001Baseline,
  expectedState,
  observe: observeM001,
  printStatus,
  environment: migrationEnvironment,
  verifyRoles,
  expectedSigner,
  recover: recoverDeployment,
  finalize,
  idleMessage,
  recordErrors,
  allowedDirtyReleases: (observation) => (observation.state === 'ready' ? [] : [DEPLOYED_RELEASE]),
  rehearsal: {
    prerequisites: [],
    fork: { rpcEnv: 'BASE_MAINNET_RPC_URL', forkBlockNumber: BASE_MAINNET_FORK_BLOCK, chainId: 8453 },
    run: rehearseM001,
  },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

function expectedState(canonical) {
  return {
    registry: canonical.contracts.registry.address,
    antsToken: canonical.contracts.antsToken.address,
    channels: canonical.contracts.channels.address,
    legacyEmissions: canonical.registryBefore?.emissions ?? canonical.contracts.emissions.address,
    legacyStaking: canonical.registryBefore?.staking ?? canonical.contracts.staking.address,
  };
}

export function classifyM001(observation) {
  const { registry, expected, deployment } = observation;
  if (!sameAddress(registry.antsToken, expected.antsToken) || !sameAddress(registry.channels, expected.channels)) {
    return 'invalid';
  }
  const emissionsLegacy = sameAddress(registry.emissions, expected.legacyEmissions);
  const stakingLegacy = sameAddress(registry.staking, expected.legacyStaking);
  if (!deployment) {
    const legacyIntact = emissionsLegacy && stakingLegacy
      && sameAddress(observation.antsRegistry, expected.registry)
      && sameAddress(observation.legacyEmissionsRegistry, expected.registry);
    return legacyIntact ? 'ready' : 'invalid';
  }
  if (!deployment.valid) return 'invalid';
  const emissionsActive = sameAddress(registry.emissions, deployment.usageAccounting);
  const stakingActive = sameAddress(registry.staking, deployment.sellerRegistry);
  if ((!emissionsLegacy && !emissionsActive) || (!stakingLegacy && !stakingActive)) return 'invalid';
  if (emissionsActive && stakingActive && !observation.channelsPaused) return 'active';
  if (emissionsActive || stakingActive || observation.channelsPaused) return 'cutover-incomplete';
  return observation.currentEpoch >= deployment.effectiveEpoch ? 'cutover-ready' : 'awaiting-epoch';
}

export function shouldRunM001Cutover(state) {
  return ['cutover-ready', 'cutover-incomplete', 'awaiting-epoch'].includes(state);
}

export function validateM001Options(options) {
  const testnetRun = options.network === M001_TESTNET && options.mode !== 'fork-test';
  const mainnetRun = options.network === M001_ANVIL_FORK;
  if (testnetRun || mainnetRun) return;
  throw new Error(
    'M001 supports Base Sepolia --dry-run/--broadcast and Base mainnet --dry-run/--broadcast/--fork-test',
  );
}

export function validateM001Baseline(canonical) {
  const required = ['registry', 'antsToken', 'channels', 'emissions', 'staking'];
  const missing = required.filter((name) => !canonical.contracts?.[name]?.address);
  if (missing.length) {
    throw new Error(`M001 ${canonical.network} deployment baseline is missing: ${missing.join(', ')}`);
  }
}

export function recordErrors(record) {
  const errors = [];
  const configuration = record.verificationConfiguration;
  if (!configuration || typeof configuration !== 'object') return ['verificationConfiguration is required'];
  const address = /^0x[0-9a-fA-F]{40}$/;
  const expect = (key, ok, description) => {
    if (!ok(configuration[key])) errors.push(`verificationConfiguration.${key} must be ${description}`);
  };
  expect('verificationMinterController', (value) => address.test(value ?? ''), 'an address');
  expect('verificationMinterShareBps', (value) => value === 10_000, '10000');
  expect('verificationMinterEditable', (value) => value === true, 'true');
  expect('pointsPolicyCount', (value) => value === 1, '1');
  expect('emissionsGateOwner', (value) => address.test(value ?? ''), 'an address');
  expect('pointsPolicyRegistryOwner', (value) => address.test(value ?? ''), 'an address');
  expect(
    'washTradingRegistry',
    (value) => address.test(value ?? '') && sameAddress(value, record.contracts?.washTradingRegistry?.address),
    'the recorded washTradingRegistry address',
  );
  if (!address.test(record.contracts?.positionInit?.address ?? '')) errors.push('contracts.positionInit is required');
  expect(
    'washTradingPointsPolicy',
    (value) => address.test(value ?? '') && sameAddress(value, record.contracts?.washTradingPointsPolicy?.address),
    'the recorded washTradingPointsPolicy address',
  );
  return errors;
}

function verificationConfiguration(context, contracts) {
  const minter = callJson(
    context.rpcUrl,
    contracts.emissionsGate.address,
    'minters(bytes32)(address,uint32,bool)',
    [VERIFICATION_MINTER_ID],
  );
  const pointsPolicyCount = numberValue(call(context.rpcUrl, contracts.pointsPolicyRegistry.address, 'policyCount()(uint256)'));
  const washTradingPointsPolicy = pointsPolicyCount === 1
    ? call(context.rpcUrl, contracts.pointsPolicyRegistry.address, 'policyAt(uint256)(address)', ['0'])
    : '0x0000000000000000000000000000000000000000';
  return {
    washTradingRegistry: call(context.rpcUrl, contracts.washTradingPointsPolicy.address, 'washTradingRegistry()(address)'),
    washTradingPointsPolicy,
    verificationMinterController: minter[0],
    verificationMinterShareBps: Number(minter[1] ?? 0),
    verificationMinterEditable: booleanValue(minter[2]),
    pointsPolicyCount,
    emissionsGateOwner: call(context.rpcUrl, contracts.emissionsGate.address, 'owner()(address)'),
    pointsPolicyRegistryOwner: call(context.rpcUrl, contracts.pointsPolicyRegistry.address, 'owner()(address)'),
  };
}

function checkpointMatchesChain(context, checkpoint, liveChainId) {
  const { rpcUrl } = context;
  const address = (name) => checkpoint.contracts?.[name]?.address;
  if (checkpoint.chainId !== liveChainId) return false;
  if (!REQUIRED_DEPLOYED_CONTRACTS.every(address)) return false;
  if (!REQUIRED_DEPLOYED_CONTRACTS.every((name) => hasCode(rpcUrl, address(name)))) return false;

  const usageAccounting = address('usageAccounting');
  const emissionsGate = address('emissionsGate');
  const pointsPolicyRegistry = address('pointsPolicyRegistry');
  const expected = checkpoint.verificationConfiguration;
  if (!expected) return false;

  if (!sameAddress(call(rpcUrl, usageAccounting, 'emissionsGate()(address)'), emissionsGate)) return false;
  if (!sameAddress(call(rpcUrl, usageAccounting, 'pointsPolicy()(address)'), pointsPolicyRegistry)) return false;

  const actual = verificationConfiguration(context, checkpoint.contracts);
  return recordErrors({ contracts: checkpoint.contracts, verificationConfiguration: actual }).length === 0
    && ['washTradingRegistry', 'washTradingPointsPolicy', 'verificationMinterController', 'emissionsGateOwner', 'pointsPolicyRegistryOwner']
      .every((key) => sameAddress(actual[key], expected[key]));
}

async function observeM001(context) {
  const { rpcUrl, expected } = context;
  const liveChainId = chainId(rpcUrl);
  if (liveChainId !== context.canonical.chainId) {
    throw new Error(`RPC chain ID ${liveChainId} does not match ${context.network} (${context.canonical.chainId})`);
  }
  const checkpoint = await readCheckpoint(context, DEPLOYED_RELEASE, (record) => checkpointFromRecord(context, record));
  const valid = checkpoint ? checkpointMatchesChain(context, checkpoint, liveChainId) : false;
  const clock = valid ? checkpoint.contracts.emissionsGate.address : expected.legacyEmissions;
  const observation = {
    chainId: liveChainId,
    expected,
    registry: {
      antsToken: call(rpcUrl, expected.registry, 'antsToken()(address)'),
      channels: call(rpcUrl, expected.registry, 'channels()(address)'),
      emissions: call(rpcUrl, expected.registry, 'emissions()(address)'),
      staking: call(rpcUrl, expected.registry, 'staking()(address)'),
    },
    antsRegistry: call(rpcUrl, expected.antsToken, 'registry()(address)'),
    legacyEmissionsRegistry: call(rpcUrl, expected.legacyEmissions, 'registry()(address)'),
    channelsPaused: call(rpcUrl, expected.channels, 'paused()(bool)') === 'true',
    currentEpoch: numberValue(call(rpcUrl, clock, 'currentEpoch()(uint256)')),
    deployment: checkpoint ? {
      valid,
      checkpoint,
      usageAccounting: checkpoint.contracts?.usageAccounting?.address,
      sellerRegistry: checkpoint.contracts?.sellerRegistry?.address,
      effectiveEpoch: checkpoint.effectiveEpoch,
    } : null,
  };
  observation.state = classifyM001(observation);
  return observation;
}

function printStatus(observation) {
  console.log(`M001 state: ${observation.state}`);
  console.log(`Registry emissions: ${observation.registry.emissions}`);
  console.log(`Registry staking:   ${observation.registry.staking}`);
  if (observation.deployment) {
    console.log(`Effective epoch:    ${observation.deployment.effectiveEpoch}`);
    console.log(`Current epoch:      ${observation.currentEpoch}`);
    console.log(`Cutover time:       ${new Date(observation.deployment.checkpoint.cutoverTimestamp * 1000).toISOString()}`);
  }
}

function idleMessage(observation) {
  if (observation.state === 'active') return 'M001 is already active; no transactions required.';
  return 'The effective epoch has not started; no transactions required.';
}

function cutoverSigners(context) {
  const usesProxy = context.network === 'base-mainnet' || Boolean(process.env.DIEM_STAKING_PROXY);
  return usesProxy ? [...CUTOVER_SIGNERS, ...CUTOVER_PROXY_SIGNERS] : CUTOVER_SIGNERS;
}

function ownedContracts(role, context, observation) {
  const { expected, rpcUrl } = context;
  switch (role) {
    case 'deployer': return observation.deployment
      ? [[observation.deployment.checkpoint.contracts.emissionsGate.address, 'emissions gate']]
      : [[expected.antsToken, 'ANTSToken'], [expected.legacyEmissions, 'legacy emissions']];
    case 'registryOwner': return [[expected.registry, 'Registry']];
    case 'channelsOwner': return [[expected.channels, 'Channels']];
    case 'sellerRewardsPoolOwner':
      return [[call(rpcUrl, expected.legacyEmissions, 'sellerRewardsPool()(address)'), 'seller rewards pool']];
    default: throw new Error(`Unknown signer role ${role}`);
  }
}

function expectedSigner(role, context, observation) {
  if (role === 'diemStaker') return process.env.DIEM_STAKER ?? BASE_MAINNET_DIEM_STAKER;
  return call(context.rpcUrl, ownedContracts(role, context, observation)[0][0], 'owner()(address)');
}

const UINT64_MAX = 2n ** 64n - 1n;

/** Mirrors the AntseedWashTradingRegistry constructor so a bad range fails before signers are unlocked. */
function verifyHistoricalPeriod(env) {
  const parse = (name) => {
    if (!/^\d+$/.test(env[name])) throw new Error(`${name} must be a decimal block number, got ${JSON.stringify(env[name])}`);
    const value = BigInt(env[name]);
    if (value > UINT64_MAX) throw new Error(`${name} exceeds uint64`);
    return value;
  };
  const start = parse('HISTORICAL_PERIOD_START_BLOCK');
  const end = parse('HISTORICAL_PERIOD_END_BLOCK');
  if (start === 0n) throw new Error('HISTORICAL_PERIOD_START_BLOCK must be nonzero');
  if (start > end) throw new Error('HISTORICAL_PERIOD_START_BLOCK must not exceed HISTORICAL_PERIOD_END_BLOCK');
}

function verifyRoles(context, observation, env) {
  requireEnvironment(['VERIFICATION_WALLET'], env);
  if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], env);
  const deploying = observation.state === 'ready';
  if (deploying) {
    requireEnvironment([
      'SP1_VERIFIER', 'SP1_VERIFIER_HASH', 'WASH_TRADING_SELLER_PROGRAM_VKEY',
      'HISTORICAL_PERIOD_START_BLOCK', 'HISTORICAL_PERIOD_END_BLOCK',
    ], env);
    verifyHistoricalPeriod(env);
  }
  const roles = deploying ? DEPLOY_SIGNERS : [...CUTOVER_SIGNERS, ...(env.DIEM_STAKING_PROXY ? ['sellerRewardsPoolOwner'] : [])];
  for (const role of roles) {
    assertSignerOwners(context.rpcUrl, env, SIGNER_ENV,
      ownedContracts(role, context, observation).map(([contract, label]) => [role, contract, label]));
  }
  if (!deploying && env.DIEM_STAKING_PROXY) {
    requireEnvironment(['DIEM_STAKER'], env);
    const staked = BigInt(call(context.rpcUrl, env.DIEM_STAKING_PROXY, 'staked(address)(uint256)', [env.DIEM_STAKER]).split(/\s/)[0]);
    if (staked === 0n) throw new Error(`diemStaker (${env.DIEM_STAKER}) has no DIEM staked on the proxy`);
  }
}

function migrationEnvironment(context, observation, signerAddresses = {}, extra = {}) {
  const checkpoint = observation.deployment?.checkpoint ?? null;
  const environment = {
    ...process.env,
    ...signerEnvironment(SIGNER_ENV, signerAddresses),
    BASE_MAINNET_RPC_URL: context.rpcUrl,
    BASE_SEPOLIA_RPC_URL: context.rpcUrl,
    ANTSEED_REGISTRY: context.expected.registry,
    EXPECTED_ANTS_TOKEN: context.expected.antsToken,
    EXPECTED_CHANNELS: context.expected.channels,
    EXPECTED_LEGACY_EMISSIONS: context.expected.legacyEmissions,
    EXPECTED_LEGACY_STAKING: context.expected.legacyStaking,
    ...(context.network === 'base-mainnet' ? { DIEM_STAKING_PROXY: BASE_MAINNET_DIEM_PROXY } : {}),
    ...extra,
  };
  if (checkpoint) {
    environment.USAGE_ACCOUNTING = checkpoint.contracts.usageAccounting.address;
    environment.SELLER_REGISTRY = checkpoint.contracts.sellerRegistry.address;
  }
  return environment;
}

function checkpointFromRecord(context, record) {
  const gate = record.contracts.emissionsGate.address;
  const genesis = numberValue(call(context.rpcUrl, gate, 'genesis()(uint256)'));
  const epochDuration = numberValue(call(context.rpcUrl, gate, 'epochDuration()(uint256)'));
  return {
    network: record.network,
    chainId: record.chainId,
    sourceCommit: record.sourceCommit,
    effectiveEpoch: record.effectiveEpoch,
    cutoverTimestamp: genesis + record.effectiveEpoch * epochDuration,
    contracts: record.contracts,
    deployTransactions: record.transactions,
    verificationConfiguration: record.verificationConfiguration,
    cutoverStarted: false,
  };
}

async function deploy(context, mode, environment, _observation, wallet) {
  runForgeScript({
    target: 'script/migrations/M001RecognizedUsage/Deploy.s.sol:M001DeployRecognizedUsage',
    rpcUrl: context.rpcUrl, broadcast: mode === 'broadcast', verify: !context.forkTest,
    etherscanApiKey: environment.BASESCAN_API_KEY, env: environment, walletArgs: wallet.forgeArgs,
  });
  if (mode !== 'broadcast') return;
  const checkpoint = await recordDeployment(context);
  console.log(`M001 deployment complete. Cutover available at ${new Date(checkpoint.cutoverTimestamp * 1000).toISOString()}.`);
  console.log('Rerun the same command after that time.');
}

async function recordDeployment(context, parsed) {
  parsed ??= await parseBroadcast(broadcastPath('Deploy.s.sol', context.canonical.chainId), context.rpcUrl, DEPLOYED_CONTRACT_NAMES);
  if (!REQUIRED_DEPLOYED_CONTRACTS.every((name) => parsed.contracts[name])) {
    throw new Error('Foundry receipt did not contain all required M001 contracts');
  }
  const record = buildReleaseRecord(context, {
    release: DEPLOYED_RELEASE, status: 'deployed', sourceCommit: sourceCommit(),
    effectiveEpoch: numberValue(call(context.rpcUrl, parsed.contracts.emissionsGate.address, 'effectiveEpoch()(uint256)')),
    verificationConfiguration: verificationConfiguration(context, parsed.contracts),
    ...parsed,
  });
  const errors = recordErrors(record);
  if (errors.length) throw new Error(`Invalid M001 deployment configuration: ${errors.join('; ')}`);
  const checkpoint = checkpointFromRecord(context, record);
  await writeCheckpoint(context, checkpoint);
  await writeHistoryRecord(context, DEPLOYED_RELEASE, record);
  return checkpoint;
}

async function cutover(context, mode, environment, observation, wallet) {
  const checkpoint = observation.deployment.checkpoint;
  if (mode === 'broadcast' && !checkpoint.cutoverStarted) {
    checkpoint.cutoverStarted = true;
    checkpoint.cutoverStartedAt = new Date().toISOString();
    await writeCheckpoint(context, checkpoint);
  }
  const canAdoptPause = mode === 'broadcast'
    && await receiptFileIsLive(path.join(context.receiptDirectory, 'pause.json'), context.rpcUrl);
  let result;
  try {
    result = await runCutover({
      rpcUrl: context.rpcUrl, chainId: context.canonical.chainId, registry: context.expected.registry,
      usageAccounting: checkpoint.contracts.usageAccounting.address,
      sellerRegistry: checkpoint.contracts.sellerRegistry.address,
      receiptDirectory: context.receiptDirectory, simulation: mode === 'dry-run', canAdoptPause,
      pauseOwner: environment.CHANNELS_OWNER, pauseWallet: wallet.signers.channelsOwner.castArgs,
      walletArgs: wallet.forgeArgs, etherscanApiKey: environment.BASESCAN_API_KEY, forkTest: context.forkTest,
      pollSeconds: environment.POLL_SECS ? Number(environment.POLL_SECS) : undefined,
      environment: { ...environment, WASH_TRADING_POINTS_POLICY: checkpoint.contracts.washTradingPointsPolicy.address },
    });
  } finally {
    if (mode === 'broadcast') await captureCutoverBroadcast(context, checkpoint);
  }
  if (mode === 'broadcast') await recordActivation(context, checkpoint);
  return result;
}

async function captureCutoverBroadcast(context, checkpoint) {
  const file = broadcastPath('Cutover.s.sol', context.canonical.chainId);
  if (!(await fileExists(file))) return;
  const parsed = await parseBroadcast(file, context.rpcUrl, DEPLOYED_CONTRACT_NAMES);
  if (!parsed.transactions.length) return;
  const merged = mergeBroadcast({ transactions: checkpoint.cutoverTransactions, contracts: checkpoint.cutoverContracts }, parsed);
  checkpoint.cutoverTransactions = merged.transactions;
  checkpoint.cutoverContracts = merged.contracts;
  await writeCheckpoint(context, checkpoint);
}

export function buildActivationRecord(context, checkpoint, transactions, verification) {
  return buildReleaseRecord(context, {
    release: ACTIVATED_RELEASE,
    status: 'active',
    sourceCommit: checkpoint.sourceCommit,
    effectiveEpoch: checkpoint.effectiveEpoch,
    transactions,
    registryBefore: { emissions: context.expected.legacyEmissions, staking: context.expected.legacyStaking },
    registryAfter: {
      emissions: checkpoint.contracts.usageAccounting.address,
      staking: checkpoint.contracts.sellerRegistry.address,
    },
    verificationConfiguration: verification,
    contracts: {
      ...Object.fromEntries(Object.entries(checkpoint.contracts).map(([name, contract]) => [
        name, { ...contract, deployedInRelease: false },
      ])),
      ...checkpoint.cutoverContracts,
    },
  });
}

async function recordActivation(context, checkpoint) {
  if (!checkpoint.cutoverTransactions?.length) {
    throw new Error('Confirmed Foundry cutover receipts are required to finalize M001 activation records');
  }
  const activeContracts = { ...checkpoint.contracts, ...checkpoint.cutoverContracts };
  const fields = {
    release: ACTIVATED_RELEASE, sourceCommit: checkpoint.sourceCommit, effectiveEpoch: checkpoint.effectiveEpoch,
    transactions: [
      ...await readReceiptFile(path.join(context.receiptDirectory, 'pause.json'), 'pause channels'),
      ...checkpoint.cutoverTransactions,
      ...await readReceiptFile(path.join(context.receiptDirectory, 'unpause.json'), 'unpause channels'),
    ],
    registryAfter: { emissions: checkpoint.contracts.usageAccounting.address, staking: checkpoint.contracts.sellerRegistry.address },
    verificationConfiguration: verificationConfiguration(context, activeContracts),
  };
  const record = buildActivationRecord(context, checkpoint, fields.transactions, fields.verificationConfiguration);
  const errors = recordErrors(record);
  if (errors.length) throw new Error(`Invalid M001 activation configuration: ${errors.join('; ')}`);
  const current = Object.assign(structuredClone(context.canonical), fields);
  applyContractAliases(current, activeContracts, CONTRACT_ALIASES);
  await writeActivationRecords(context, record, current);
}

async function recoverDeployment(context, observation) {
  if (observation.deployment) return false;
  const broadcastFile = broadcastPath('Deploy.s.sol', context.canonical.chainId);
  if (!(await broadcastIsLive(broadcastFile, context.rpcUrl))) return false;
  const parsed = await parseBroadcast(broadcastFile, context.rpcUrl, DEPLOYED_CONTRACT_NAMES);
  const gate = parsed.contracts.emissionsGate?.address;
  const escrow = parsed.contracts.legacyEmissionsEscrow?.address;
  if (!gate || !escrow) return false;
  if (!sameAddress(call(context.rpcUrl, context.expected.antsToken, 'registry()(address)'), gate)) return false;
  if (!sameAddress(call(context.rpcUrl, context.expected.legacyEmissions, 'registry()(address)'), escrow)) return false;
  await recordDeployment(context, parsed);
  console.log('Recovered the M001 deployment checkpoint from confirmed Foundry receipts.');
  return true;
}

async function finalize(context, observation, mode) {
  if (observation.state !== 'active' || mode !== 'broadcast' || !observation.deployment) return false;
  const historyWritten = await historyRecordExists(context, ACTIVATED_RELEASE);
  if (historyWritten && await currentRelease(context) === ACTIVATED_RELEASE) return false;
  const checkpoint = observation.deployment.checkpoint;
  await assertCheckpointBytecode(context, checkpoint);
  await captureCutoverBroadcast(context, checkpoint);
  await recordActivation(context, checkpoint);
  console.log(historyWritten
    ? 'Recovered M001 current.json from confirmed on-chain state; the history record already existed.'
    : 'Recovered M001 activation records from confirmed on-chain state and Foundry receipts.');
  return true;
}

// Local --fork-test fixtures; deployment and cutover still use the production phases.

export const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
export const ANVIL_ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

export function prepareForkOwners(context) {
  const { rpcUrl, expected } = context;
  const rewardsPool = call(rpcUrl, expected.legacyEmissions, 'sellerRewardsPool()(address)');
  for (const [contract, recipient] of [
    [expected.registry, ANVIL_ACCOUNT_0],
    [expected.antsToken, ANVIL_ACCOUNT_0],
    [expected.legacyEmissions, ANVIL_ACCOUNT_0],
    [expected.channels, ANVIL_ACCOUNT_1],
    [rewardsPool, ANVIL_ACCOUNT_1],
  ]) {
    const owner = call(rpcUrl, contract, 'owner()(address)');
    impersonatedSend(rpcUrl, owner, contract, 'transferOwnership(address)', [recipient]);
  }
}

export function deployForkVerifierStub(rpcUrl) {
  const runtime = '600160005260206000f3';
  const initcode = `0x69${runtime}600052600a6016f3`;
  // `--create <CODE>` is a cast subcommand and must be the final argument.
  const receipt = JSON.parse(
    capture('cast', ['send', '--rpc-url', rpcUrl, '--unlocked', '--from', ANVIL_ACCOUNT_0, '--json', '--create', initcode]),
  );
  return receipt.contractAddress;
}

/** Unlocks the impersonated staker so Cutover.s.sol can claim as it on the fork. */
export function prepareForkStaker(context) {
  cast(context.rpcUrl, ['rpc', 'anvil_impersonateAccount', BASE_MAINNET_DIEM_STAKER]);
  cast(context.rpcUrl, ['rpc', 'anvil_setBalance', BASE_MAINNET_DIEM_STAKER, '0x3635C9ADC5DEA00000']);
}

async function rehearseM001({ rpcUrl, outputRoot, network, runMigration: drive }) {
  const context = await loadContext(migration, network, { rpcUrl, outputRoot, canonicalRoot: outputRoot, forkTest: true });
  prepareForkOwners(context);
  const environment = {
    SP1_VERIFIER: process.env.SP1_VERIFIER ?? deployForkVerifierStub(rpcUrl),
    SP1_VERIFIER_HASH: process.env.SP1_VERIFIER ? process.env.SP1_VERIFIER_HASH : `0x${'0'.repeat(63)}1`,
    WASH_TRADING_SELLER_PROGRAM_VKEY: process.env.WASH_TRADING_SELLER_PROGRAM_VKEY ?? `0x${'0'.repeat(63)}1`,
    HISTORICAL_PERIOD_START_BLOCK: process.env.HISTORICAL_PERIOD_START_BLOCK ?? '1',
    HISTORICAL_PERIOD_END_BLOCK: process.env.HISTORICAL_PERIOD_END_BLOCK ?? String(BASE_MAINNET_FORK_BLOCK),
    VERIFICATION_WALLET: ANVIL_ACCOUNT_1,
    DIEM_STAKING_PROXY: BASE_MAINNET_DIEM_PROXY,
    ANTSEED_DEPLOY_CONFIRM: network,
  };
  // Every role is an Anvil-unlocked account; the fork test signs nothing.
  const signers = {
    deployer: `unlocked:${ANVIL_ACCOUNT_0}`,
    registryOwner: `unlocked:${ANVIL_ACCOUNT_0}`,
    channelsOwner: `unlocked:${ANVIL_ACCOUNT_1}`,
    sellerRewardsPoolOwner: `unlocked:${ANVIL_ACCOUNT_1}`,
    diemStaker: `unlocked:${BASE_MAINNET_DIEM_STAKER}`,
  };
  const overrides = { environment, signers };

  let observation = await drive(overrides);
  if (observation.state !== 'awaiting-epoch') throw new Error(`Expected awaiting-epoch, got ${observation.state}`);

  const checkpoint = observation.deployment.checkpoint;
  advanceTimeTo(rpcUrl, checkpoint.cutoverTimestamp + 1);
  prepareForkStaker(context);

  observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error(`Expected active, got ${observation.state}`);

  observation = await drive(overrides);
  if (observation.state !== 'active') throw new Error('Repeated broadcast was not an active no-op');
}

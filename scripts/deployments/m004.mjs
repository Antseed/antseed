import path from 'node:path';
import { call, cast, chainId, hasCode, numberValue, sameAddress, transactionSucceeded } from './runtime/chain.mjs';
import { sourceCommit } from './runtime/exec.mjs';
import { requireEnvironment } from './runtime/env.mjs';
import { fileExists, readJson } from './runtime/fsx.mjs';
import { broadcastPath, mergeBroadcast, parseBroadcast, runForgeScript, simulationPath } from './runtime/foundry.mjs';
import { buildArtifactIndex, compareRuntimeCode, findArtifact } from './runtime/bytecode.mjs';
import {
  applyContractAliases, buildReleaseRecord, historyFile, historyRecordExists, readCheckpoint,
  writeActivationRecords, writeCheckpoint,
} from './runtime/ledger.mjs';
import { runMigration } from './runtime/runner.mjs';
import { clearPlan } from './runtime/plan.mjs';
import { CONTRACTS_ROOT } from './runtime/paths.mjs';

/**
 * The staked free-tier promise board (`AntseedFreeTierTerms`). It has no owner and nothing is wired to it;
 * sellers write their promises to it, and nodes and apps read them.
 */
export const RELEASE = '004-free-tier-promises';
export const POLICY_NOTE = 'M004 deploys the staked free-tier promise board. It has no owner, holds no funds and '
  + 'changes no points; sellers publish their free tier for stakers on it.';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const KEY = 'freeTierTerms';
const CONTRACT_NAMES = { AntseedFreeTierTerms: KEY };
const BASELINE = ['registry', 'identityRegistry', 'sellerRegistry', 'usageAccounting', 'emissionsGate'];
const TARGET = 'script/migrations/M004FreeTierPromises/Deploy.s.sol:M004DeployFreeTierPromises';

function receiptFile(context, simulated = false) {
  const file = (simulated ? simulationPath : broadcastPath)('Deploy.s.sol', context.canonical.chainId);
  return context.forkTest ? path.join(context.receiptDirectory, path.relative(CONTRACTS_ROOT, file)) : file;
}

/** The wallet that deploys the board; it gets no rights over it. */
export function freeTierDeployer(value = process.env.FREE_TIER_DEPLOYER) {
  const deployer = value?.trim() ?? '';
  if (!ADDRESS.test(deployer) || sameAddress(deployer, ZERO)) {
    throw new Error('FREE_TIER_DEPLOYER must be the nonzero address of the deploying wallet');
  }
  return deployer;
}

export function validateBaseline(canonical) {
  for (const name of BASELINE) {
    if (!ADDRESS.test(canonical.contracts?.[name]?.address ?? '')) throw new Error(`M004 missing ${name}`);
  }
}

export function recordErrors(record) {
  const config = record.verificationConfiguration?.freeTierPromises;
  const contract = record.contracts?.[KEY];
  if (!config || !contract) return ['M004 requires the free-tier board and its configuration'];
  const errors = [];
  for (const key of [...BASELINE, 'deployer', 'boardAddress']) {
    if (!ADDRESS.test(config[key] ?? '') || sameAddress(config[key], ZERO)) errors.push(`M004 invalid ${key}`);
  }
  if (!sameAddress(contract.address, config.boardAddress)) errors.push('M004 board address mismatch');
  if (contract.owner !== null) errors.push('M004 board must record no owner');
  const expected = [config.registry, config.emissionsGate, config.identityRegistry];
  const actual = contract.constructorArguments ?? [];
  if (actual.length !== expected.length || expected.some((value, index) => !sameAddress(actual[index], value))) {
    errors.push('M004 board constructor mismatch');
  }
  if (!Number.isSafeInteger(config.deploymentNonce) || config.deploymentNonce < 0) errors.push('M004 invalid nonce');
  return errors;
}

async function collectReceipts(context, checkpoint) {
  const file = receiptFile(context);
  if (!(await fileExists(file))) return checkpoint;
  const parsed = await parseBroadcast(file, context.rpcUrl, CONTRACT_NAMES);
  const board = parsed.contracts[KEY];
  if (!board || !sameAddress(board.address, checkpoint.boardAddress)) return checkpoint;
  const transactions = parsed.transactions.filter((transaction) => transaction.hash === board.transactionHash);
  if (transactions.some((transaction) => !transactionSucceeded(context.rpcUrl, transaction.hash))) {
    throw new Error('M004 receipts are not confirmed on this chain');
  }
  const combined = { ...checkpoint, ...mergeBroadcast(checkpoint, { transactions, contracts: { [KEY]: board } }) };
  await writeCheckpoint(context, combined);
  return combined;
}

async function observe(context) {
  const { rpcUrl, expected, canonical } = context;
  if (chainId(rpcUrl) !== canonical.chainId) throw new Error('M004 wrong RPC chain');
  if (BASELINE.some((name) => !hasCode(rpcUrl, expected[name]))
    || !sameAddress(call(rpcUrl, expected.registry, 'identityRegistry()(address)'), expected.identityRegistry)
    || !sameAddress(call(rpcUrl, expected.registry, 'staking()(address)'), expected.sellerRegistry)
    || !sameAddress(call(rpcUrl, expected.registry, 'emissions()(address)'), expected.usageAccounting)
    || !sameAddress(call(rpcUrl, expected.sellerRegistry, 'identityRegistry()(address)'), expected.identityRegistry)
    || !sameAddress(call(rpcUrl, expected.usageAccounting, 'emissionsGate()(address)'), expected.emissionsGate)) {
    throw new Error('M004 registry, seller registry, identity registry, usage accounting or emissions gate mismatch');
  }
  let checkpoint = await readCheckpoint(context, RELEASE, (record) => ({
    ...record.verificationConfiguration.freeTierPromises,
    sourceCommit: record.sourceCommit, contracts: record.contracts, transactions: record.transactions,
  }));
  if (!checkpoint) {
    if (canonical.contracts[KEY]) throw new Error('M004 free-tier board exists without its history record');
    const file = receiptFile(context);
    if (await fileExists(file)) {
      const broadcast = await readJson(file);
      if (broadcast.transactions?.some((transaction) => Object.hasOwn(CONTRACT_NAMES, transaction.contractName))) {
        throw new Error('M004 prior broadcast exists; restore its checkpoint or history before continuing');
      }
    }
    const deployer = freeTierDeployer();
    const deploymentNonce = numberValue(cast(rpcUrl, ['nonce', deployer]));
    const boardAddress = cast(rpcUrl, ['compute-address', deployer, '--nonce', String(deploymentNonce)]).match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (!boardAddress) throw new Error('M004 could not compute the board address');
    checkpoint = { ...expected, deployer, deploymentNonce, boardAddress, sourceCommit: sourceCommit(), contracts: {}, transactions: [] };
  } else {
    if (BASELINE.some((name) => !sameAddress(checkpoint[name], expected[name]))) throw new Error('M004 checkpoint baseline mismatch');
    checkpoint = await collectReceipts(context, checkpoint);
  }
  if (process.env.FREE_TIER_DEPLOYER !== undefined && !sameAddress(freeTierDeployer(), checkpoint.deployer)) {
    throw new Error('M004 FREE_TIER_DEPLOYER differs from the original deployment');
  }
  if (!hasCode(rpcUrl, checkpoint.boardAddress)) {
    if (checkpoint.contracts[KEY]
      || numberValue(cast(rpcUrl, ['nonce', checkpoint.deployer, '--block', 'pending'])) !== checkpoint.deploymentNonce) {
      throw new Error('M004 board is missing or its nonce is in use; reconcile the original broadcast');
    }
    return { state: 'ready', deployment: { checkpoint } };
  }
  const found = await findArtifact(await buildArtifactIndex(), KEY);
  if (!found) throw new Error('M004 missing the board artifact; run forge build');
  const mismatch = compareRuntimeCode(rpcUrl, checkpoint.boardAddress, found.artifact);
  if (mismatch) throw new Error(`M004 board ${mismatch}`);
  for (const [signature, value] of [['registry()(address)', expected.registry], ['gate()(address)', expected.emissionsGate],
    ['identity()(address)', expected.identityRegistry]]) {
    if (!sameAddress(call(rpcUrl, checkpoint.boardAddress, signature), value)) throw new Error('M004 board wiring mismatch');
  }
  if (!checkpoint.contracts[KEY]) throw new Error('M004 restore the confirmed board deployment receipt before continuing');
  return { state: 'active', deployment: { checkpoint } };
}

export function activationRecords(context, checkpoint) {
  const { sourceCommit: commit, contracts, transactions, ...configuration } = checkpoint;
  const ownerless = { [KEY]: { ...contracts[KEY], owner: null } };
  const verificationConfiguration = { ...context.canonical.verificationConfiguration, freeTierPromises: configuration };
  const record = buildReleaseRecord(context, {
    release: RELEASE, status: 'active', sourceCommit: commit, contracts: ownerless, transactions, verificationConfiguration,
    notes: POLICY_NOTE,
  });
  const current = applyContractAliases(structuredClone(context.canonical), ownerless, {});
  Object.assign(current, { release: RELEASE, status: 'active', sourceCommit: commit, transactions, verificationConfiguration, notes: POLICY_NOTE });
  return { record, current };
}

async function finalize(context, observation, mode) {
  if (mode !== 'broadcast' || observation.state !== 'active') return false;
  const checkpoint = observation.deployment.checkpoint;
  if (await historyRecordExists(context, RELEASE)) {
    const recorded = await readJson(historyFile(context, RELEASE));
    if (!sameAddress(recorded.contracts[KEY]?.address, checkpoint.boardAddress)) throw new Error('M004 history address mismatch');
    if (sameAddress(context.canonical.contracts[KEY]?.address, checkpoint.boardAddress)) {
      await clearPlan(context, RELEASE);
      return false;
    }
  }
  if (!checkpoint.contracts[KEY]?.transactionHash) throw new Error('M004 confirmed creation receipt required');
  const { record, current } = activationRecords(context, checkpoint);
  const errors = recordErrors(record);
  if (errors.length) throw new Error(errors.join('\n'));
  await writeActivationRecords(context, record, current);
  await clearPlan(context, RELEASE);
  return true;
}

const deployPhase = {
  id: 'deploy',
  guard: (observation) => observation.state === 'ready',
  signers: () => ['freeTierDeployer'],
  plan: (context, observation) => ({
    release: RELEASE, phaseId: 'deploy', simulationFile: receiptFile(context, true),
    pointerChanges: {
      [`current.contracts.${KEY}`]: {
        before: context.canonical.contracts[KEY]?.address ?? 'not deployed',
        after: observation.deployment.checkpoint.boardAddress,
      },
    },
  }),
  async run(context, mode, environment, observation, wallet) {
    if (mode === 'broadcast') await writeCheckpoint(context, observation.deployment.checkpoint);
    try {
      runForgeScript({
        target: TARGET, rpcUrl: context.rpcUrl, broadcast: mode === 'broadcast', verify: !context.forkTest,
        etherscanApiKey: environment.BASESCAN_API_KEY, env: environment, walletArgs: wallet.forgeArgs,
      });
    } finally {
      if (mode === 'broadcast') await collectReceipts(context, observation.deployment.checkpoint);
    }
    if (mode === 'broadcast') {
      const after = await observe(context);
      if (after.state !== 'active') throw new Error('M004 deployment did not complete');
      await finalize(context, after, mode);
    }
  },
};

export const migration = {
  id: 'M004',
  checkpointName: 'm004-free-tier-promises',
  networks: ['base-sepolia', 'base-mainnet'],
  releases: [RELEASE],
  phases: [deployPhase],
  validateOptions(options) {
    if (!this.networks.includes(options.network) || (options.mode === 'fork-test' && options.network !== 'base-mainnet')) {
      throw new Error('M004 supports Base Sepolia/mainnet dry-run/broadcast and Base mainnet fork-test');
    }
  },
  validateBaseline,
  expectedState: (canonical) => Object.fromEntries(BASELINE.map((name) => [name, canonical.contracts[name].address])),
  observe,
  printStatus: (observation) => console.log(`M004 state: ${observation.state}`),
  expectedSigner: (_role, _context, observation) => observation.deployment.checkpoint.deployer,
  environment(context, observation, signers, extra = {}) {
    const checkpoint = observation.deployment.checkpoint;
    return {
      ...process.env, ...extra, EXPECTED_CHAIN_ID: String(context.canonical.chainId),
      ANTSEED_REGISTRY: checkpoint.registry, EXPECTED_IDENTITY_REGISTRY: checkpoint.identityRegistry,
      USAGE_ACCOUNTING: checkpoint.usageAccounting, EMISSIONS_GATE: checkpoint.emissionsGate,
      FREE_TIER_DEPLOYER: signers.freeTierDeployer, FREE_TIER_DEPLOYMENT_NONCE: String(checkpoint.deploymentNonce),
      ...(context.forkTest ? { FOUNDRY_BROADCAST: path.join(context.receiptDirectory, 'broadcast') } : {}),
    };
  },
  verifyRoles(context, observation, environment) {
    if (!sameAddress(environment.FREE_TIER_DEPLOYER, observation.deployment.checkpoint.deployer)) {
      throw new Error('M004 wrong freeTierDeployer signer');
    }
    if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], environment);
  },
  finalize,
  idleMessage: () => 'M004 already active; no transactions required.',
  recordErrors,
  allowedDirtyReleases: () => [],
  rehearsal: {
    prerequisites: ['M001'],
    async run({ runMigration: drive }) {
      // Anvil account 1: a deployer with no other role.
      const deployer = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
      const overrides = { signers: { freeTierDeployer: `unlocked:${deployer}` } };
      const previous = process.env.FREE_TIER_DEPLOYER;
      process.env.FREE_TIER_DEPLOYER = deployer;
      let first;
      let second;
      try {
        first = await drive(overrides);
        second = await drive(overrides);
      } finally {
        if (previous === undefined) delete process.env.FREE_TIER_DEPLOYER;
        else process.env.FREE_TIER_DEPLOYER = previous;
      }
      if (first.state !== 'active' || second.state !== 'active'
        || !sameAddress(first.deployment.checkpoint.boardAddress, second.deployment.checkpoint.boardAddress)
        || first.deployment.checkpoint.transactions.length !== second.deployment.checkpoint.transactions.length) {
        throw new Error('M004 rehearsal must deploy once and repeat as an active no-op');
      }
    },
  },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

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

export const RELEASE = '003-verification-registry';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACT_NAMES = { AntseedVerification: 'verification' };
const TARGET = 'script/migrations/M003VerificationRegistry/Deploy.s.sol:M003DeployVerificationRegistry';

function receiptFile(context, simulated = false) {
  const file = (simulated ? simulationPath : broadcastPath)('Deploy.s.sol', context.canonical.chainId);
  return context.forkTest ? path.join(context.receiptDirectory, path.relative(CONTRACTS_ROOT, file)) : file;
}

export function parseVerifiers(value = '') {
  const verifiers = value.trim() ? value.split(',').map((address) => address.trim().toLowerCase()) : [];
  if (verifiers.some((address) => !ADDRESS.test(address) || sameAddress(address, ZERO))) {
    throw new Error('VERIFICATION_VERIFIERS must be comma-separated nonzero addresses');
  }
  if (new Set(verifiers).size !== verifiers.length) throw new Error('Duplicate VERIFICATION_VERIFIERS');
  return verifiers.sort();
}

export function validateBaseline(canonical) {
  for (const name of ['registry', 'identityRegistry']) {
    if (!ADDRESS.test(canonical.contracts?.[name]?.address ?? '')) throw new Error(`M003 missing ${name}`);
  }
}

export function recordErrors(record) {
  const config = record.verificationConfiguration?.verificationRegistry;
  const contract = record.contracts?.verification;
  if (!config || !contract) return ['M003 requires verification contract and configuration'];
  const errors = [];
  for (const key of ['registry', 'identityRegistry', 'owner', 'address']) {
    if (!ADDRESS.test(config[key] ?? '') || sameAddress(config[key], ZERO)) errors.push(`M003 invalid ${key}`);
  }
  if (!sameAddress(contract.address, config.address)) errors.push('M003 verification address mismatch');
  if (!sameAddress(contract.owner, config.owner)) errors.push('M003 verification owner mismatch');
  if (contract.constructorArguments?.length !== 1 || !sameAddress(contract.constructorArguments[0], config.registry)) {
    errors.push('M003 verification constructor mismatch');
  }
  if (!Number.isSafeInteger(config.deploymentNonce) || config.deploymentNonce < 0) errors.push('M003 invalid nonce');
  try {
    if (!Array.isArray(config.verifiers)) throw new Error('M003 verifiers must be an array');
    parseVerifiers(config.verifiers.join(','));
  } catch (error) { errors.push(error.message); }
  return errors;
}

async function collectReceipts(context, checkpoint) {
  const file = receiptFile(context);
  if (!(await fileExists(file))) return checkpoint;
  const parsed = await parseBroadcast(file, context.rpcUrl, CONTRACT_NAMES);
  const creation = parsed.contracts.verification;
  if (creation && !sameAddress(creation.address, checkpoint.address)) return checkpoint;
  const transactions = parsed.transactions.filter((transaction) =>
    sameAddress(transaction.to, checkpoint.address) || transaction.hash === creation?.transactionHash);
  if (!transactions.length) return checkpoint;
  if (transactions.some((transaction) => !transactionSucceeded(context.rpcUrl, transaction.hash))) {
    throw new Error('M003 receipts are not confirmed on this chain');
  }
  const combined = { ...checkpoint, ...mergeBroadcast(checkpoint, {
    transactions, contracts: creation ? { verification: creation } : {},
  }) };
  await writeCheckpoint(context, combined);
  return combined;
}

async function observe(context) {
  const { rpcUrl, expected, canonical } = context;
  if (chainId(rpcUrl) !== canonical.chainId) throw new Error('M003 wrong RPC chain');
  if (!hasCode(rpcUrl, expected.registry) || !hasCode(rpcUrl, expected.identityRegistry)
    || !sameAddress(call(rpcUrl, expected.registry, 'identityRegistry()(address)'), expected.identityRegistry)) {
    throw new Error('M003 registry or identity registry mismatch');
  }
  let checkpoint = await readCheckpoint(context, RELEASE, (record) => ({
    ...record.verificationConfiguration.verificationRegistry,
    sourceCommit: record.sourceCommit, contracts: record.contracts, transactions: record.transactions,
  }));
  if (!checkpoint) {
    if (canonical.contracts.verification) throw new Error('M003 verification exists without its history record');
    const file = receiptFile(context);
    if (await fileExists(file)) {
      const broadcast = await readJson(file);
      if (broadcast.transactions?.some((transaction) => transaction.contractName === 'AntseedVerification')) {
        throw new Error('M003 prior broadcast exists; restore its checkpoint or history before continuing');
      }
    }
    const owner = call(rpcUrl, expected.registry, 'owner()(address)');
    const deploymentNonce = numberValue(cast(rpcUrl, ['nonce', owner]));
    const address = cast(rpcUrl, ['compute-address', owner, '--nonce', String(deploymentNonce)]).match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (!address) throw new Error('M003 could not compute deployment address');
    checkpoint = {
      ...expected, owner, deploymentNonce, address, verifiers: parseVerifiers(process.env.VERIFICATION_VERIFIERS),
      sourceCommit: sourceCommit(), contracts: {}, transactions: [],
    };
  } else {
    if (!sameAddress(checkpoint.registry, expected.registry) || !sameAddress(checkpoint.identityRegistry, expected.identityRegistry)) {
      throw new Error('M003 checkpoint baseline mismatch');
    }
    if (process.env.VERIFICATION_VERIFIERS !== undefined
      && JSON.stringify(parseVerifiers(process.env.VERIFICATION_VERIFIERS)) !== JSON.stringify(checkpoint.verifiers)) {
      throw new Error('M003 verifier list differs from the original deployment; restore the reviewed list');
    }
    checkpoint = await collectReceipts(context, checkpoint);
  }
  const verification = checkpoint.address;
  let state = 'ready';
  if (hasCode(rpcUrl, verification)) {
    const found = await findArtifact(await buildArtifactIndex(), 'verification');
    if (!found) throw new Error('M003 missing AntseedVerification artifact; run forge build');
    const mismatch = compareRuntimeCode(rpcUrl, verification, found.artifact);
    if (mismatch) throw new Error(`M003 ${mismatch}`);
    if (!sameAddress(call(rpcUrl, verification, 'registry()(address)'), expected.registry)
      || !sameAddress(call(rpcUrl, verification, 'owner()(address)'), checkpoint.owner)
      || !sameAddress(call(rpcUrl, verification, 'pendingOwner()(address)'), ZERO)) {
      throw new Error('M003 verification registry or ownership mismatch');
    }
    if (!checkpoint.contracts.verification) throw new Error('M003 restore confirmed deployment receipts before continuing');
    const approved = checkpoint.verifiers.every((verifier) => call(rpcUrl, verification, 'approvedVerifiers(address)(bool)', [verifier]) === 'true');
    if (!approved && await historyRecordExists(context, RELEASE)) {
      throw new Error('M003 initial approvals changed after activation; manage verifiers separately');
    }
    state = approved ? 'active' : 'ready';
  } else if (checkpoint.contracts.verification
    || numberValue(cast(rpcUrl, ['nonce', checkpoint.owner, '--block', 'pending'])) !== checkpoint.deploymentNonce) {
    throw new Error('M003 deployment is missing or its nonce is in use; reconcile the original broadcast');
  }
  return { state, deployment: { checkpoint } };
}

export function activationRecords(context, checkpoint) {
  const { sourceCommit: commit, contracts, transactions, ...configuration } = checkpoint;
  const verificationConfiguration = {
    ...context.canonical.verificationConfiguration, verificationRegistry: configuration,
  };
  const record = buildReleaseRecord(context, {
    release: RELEASE, status: 'active', sourceCommit: commit, contracts, transactions, verificationConfiguration,
  });
  const current = applyContractAliases(structuredClone(context.canonical), contracts, {});
  Object.assign(current, { release: RELEASE, status: 'active', sourceCommit: commit, transactions, verificationConfiguration });
  return { record, current };
}

async function finalize(context, observation, mode) {
  if (mode !== 'broadcast' || observation.state !== 'active') return false;
  const checkpoint = observation.deployment.checkpoint;
  if (await historyRecordExists(context, RELEASE)
    && sameAddress(context.canonical.contracts.verification?.address, checkpoint.address)) {
    await clearPlan(context, RELEASE);
    return false;
  }
  if (!checkpoint.contracts.verification?.transactionHash) throw new Error('M003 confirmed creation receipt required');
  const { record, current } = activationRecords(context, checkpoint);
  if (recordErrors(record).length) throw new Error(recordErrors(record).join('\n'));
  if (await historyRecordExists(context, RELEASE)) {
    const recorded = await readJson(historyFile(context, RELEASE));
    if (!sameAddress(recorded.contracts.verification.address, checkpoint.address)) throw new Error('M003 history address mismatch');
  }
  await writeActivationRecords(context, record, current);
  await clearPlan(context, RELEASE);
  return true;
}

const deployPhase = {
  id: 'deploy',
  guard: (observation) => observation.state === 'ready',
  signers: () => ['verificationOwner'],
  plan: (context, observation) => ({
    release: RELEASE, phaseId: 'deploy', simulationFile: receiptFile(context, true),
    pointerChanges: {
      'current.contracts.verification': {
        before: context.canonical.contracts.verification?.address ?? 'not deployed',
        after: observation.deployment.checkpoint.address,
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
      if (after.state !== 'active') throw new Error('M003 deployment did not complete');
      await finalize(context, after, mode);
    }
  },
};

export const migration = {
  id: 'M003',
  networks: ['base-sepolia', 'base-mainnet'],
  releases: [RELEASE],
  phases: [deployPhase],
  validateOptions(options) {
    if (!this.networks.includes(options.network) || (options.mode === 'fork-test' && options.network !== 'base-mainnet')) {
      throw new Error('M003 supports Base Sepolia/mainnet dry-run/broadcast and Base mainnet fork-test');
    }
  },
  validateBaseline,
  expectedState: (canonical) => ({ registry: canonical.contracts.registry.address, identityRegistry: canonical.contracts.identityRegistry.address }),
  observe,
  printStatus: (observation) => console.log(`M003 state: ${observation.state}`),
  expectedSigner: (_role, _context, observation) => observation.deployment.checkpoint.owner,
  environment(context, observation, signers, extra = {}) {
    const checkpoint = observation.deployment.checkpoint;
    return {
      ...process.env, ...extra, EXPECTED_CHAIN_ID: String(context.canonical.chainId),
      ANTSEED_REGISTRY: checkpoint.registry, EXPECTED_IDENTITY_REGISTRY: checkpoint.identityRegistry,
      VERIFICATION_OWNER: signers.verificationOwner, VERIFICATION_DEPLOYMENT_NONCE: String(checkpoint.deploymentNonce),
      VERIFICATION_VERIFIERS: checkpoint.verifiers.join(','),
      ...(context.forkTest ? { FOUNDRY_BROADCAST: path.join(context.receiptDirectory, 'broadcast') } : {}),
    };
  },
  verifyRoles(context, observation, environment) {
    if (!sameAddress(environment.VERIFICATION_OWNER, observation.deployment.checkpoint.owner)) throw new Error('M003 wrong verificationOwner signer');
    if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], environment);
  },
  finalize,
  idleMessage: () => 'M003 already active; no transactions required.',
  recordErrors,
  allowedDirtyReleases: () => [],
  rehearsal: {
    prerequisites: ['M001'],
    async run({ runMigration: drive }) {
      const overrides = { signers: { verificationOwner: 'unlocked:0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' } };
      const first = await drive(overrides);
      const second = await drive(overrides);
      if (first.state !== 'active' || second.state !== 'active'
        || !sameAddress(first.deployment.checkpoint.address, second.deployment.checkpoint.address)
        || first.deployment.checkpoint.transactions.length !== second.deployment.checkpoint.transactions.length) {
        throw new Error('M003 rehearsal must deploy once and repeat as an active no-op');
      }
    },
  },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

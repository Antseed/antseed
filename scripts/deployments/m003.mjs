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
 * The verification deployment with audits, per-epoch claims and per-verdict lifetimes. It replaces
 * M003's earlier deployments, whose records (`003-kbf-verification`, `003-verification-split`) stay
 * in the append-only history; those releases have no owner now.
 */
export const RELEASE = '003-verification-audits';
export const POLICY_NOTE = 'M003 deploys the verification results layer, the KBF audit and '
  + 'the verification points policy, and wires KBF as an audit with the whole verification bucket. It approves no '
  + 'auditors and does not register the policy in the points policy registry; the owners do that separately, so '
  + 'verdicts change no seller points until then.';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
/** Solidity contract name → ledger key, in deployment (nonce) order. */
const CONTRACT_NAMES = {
  AntseedVerificationResults: 'verificationResults',
  AntseedKbfAudits: 'kbfAudits',
  AntseedVerificationPointsPolicy: 'verificationPointsPolicy',
};
/** Ledger key → checkpoint address field, in deployment (nonce) order. */
export const DEPLOYMENTS = [
  ['verificationResults', 'resultsAddress'],
  ['kbfAudits', 'kbfAddress'],
  ['verificationPointsPolicy', 'policyAddress'],
];
const KBF_SHARE_BPS = 10_000;
export const DEFAULT_BONUS_BPS = 0;
const MAX_BONUS_BPS = 5_000;
const TARGET = 'script/migrations/M003VerificationRegistry/Deploy.s.sol:M003DeployVerificationRegistry';

function receiptFile(context, simulated = false) {
  const file = (simulated ? simulationPath : broadcastPath)('Deploy.s.sol', context.canonical.chainId);
  return context.forkTest ? path.join(context.receiptDirectory, path.relative(CONTRACTS_ROOT, file)) : file;
}

/** M003 never approves auditors; the owner does that separately with setAuditor after the deploy. */
export function rejectAuditorList(value = process.env.VERIFICATION_AUDITORS) {
  if (value !== undefined && value.trim() !== '') {
    throw new Error('M003 does not approve auditors; unset VERIFICATION_AUDITORS and approve them separately with setAuditor');
  }
}

/**
 * The wallet that deploys and owns all three contracts. M003 only deploys, so it need not own the
 * points policy registry; the registry owner registers the policy later as a separate step.
 */
export function verificationOwner(value = process.env.VERIFICATION_OWNER) {
  const owner = value?.trim() ?? '';
  if (!ADDRESS.test(owner) || sameAddress(owner, ZERO)) {
    throw new Error('VERIFICATION_OWNER must be the nonzero address of the deploying wallet');
  }
  return owner;
}

export function parseBonusBps(value) {
  if (value === undefined || value === '') return DEFAULT_BONUS_BPS;
  const parsed = Number(value);
  if (!/^\d+$/.test(String(value).trim()) || !Number.isSafeInteger(parsed) || parsed > MAX_BONUS_BPS) {
    throw new Error(`VERIFICATION_BONUS_BPS must be an integer from 0 to ${MAX_BONUS_BPS}`);
  }
  return parsed;
}

export function validateBaseline(canonical) {
  for (const name of ['registry', 'identityRegistry', 'sellerPools', 'usageAccounting', 'pointsPolicyRegistry', 'emissionsGate']) {
    if (!ADDRESS.test(canonical.contracts?.[name]?.address ?? '')) throw new Error(`M003 missing ${name}`);
  }
}

function constructorMatches(contract, expected) {
  const actual = contract.constructorArguments ?? [];
  return actual.length === expected.length && expected.every((value, index) => (
    ADDRESS.test(String(value)) ? sameAddress(actual[index], value) : String(actual[index]) === String(value)
  ));
}

export function recordErrors(record) {
  const config = record.verificationConfiguration?.verificationRegistry;
  const contracts = record.contracts ?? {};
  if (!config || DEPLOYMENTS.some(([key]) => !contracts[key])) return ['M003 requires verification contracts and configuration'];
  const errors = [];
  for (const key of ['registry', 'identityRegistry', 'sellerPools', 'usageAccounting', 'pointsPolicyRegistry', 'emissionsGate', 'owner',
    ...DEPLOYMENTS.map(([, field]) => field)]) {
    if (!ADDRESS.test(config[key] ?? '') || sameAddress(config[key], ZERO)) errors.push(`M003 invalid ${key}`);
  }
  for (const [key, field] of DEPLOYMENTS) {
    if (!sameAddress(contracts[key].address, config[field])) errors.push(`M003 ${key} address mismatch`);
    if (!sameAddress(contracts[key].owner, config.owner)) errors.push(`M003 ${key} owner mismatch`);
  }
  const expectedArguments = {
    verificationResults: [config.emissionsGate],
    kbfAudits: [config.resultsAddress, config.sellerPools, config.identityRegistry],
    verificationPointsPolicy: [config.resultsAddress, config.usageAccounting, config.bonusBps, config.owner],
  };
  for (const [key] of DEPLOYMENTS) {
    if (!constructorMatches(contracts[key], expectedArguments[key])) errors.push(`M003 ${key} constructor mismatch`);
  }
  try { parseBonusBps(String(config.bonusBps)); } catch (error) { errors.push(error.message); }
  if (!Number.isSafeInteger(config.deploymentNonce) || config.deploymentNonce < 0) errors.push('M003 invalid nonce');
  if (config.auditors !== undefined) errors.push('M003 records no auditors');
  return errors;
}

async function collectReceipts(context, checkpoint) {
  const file = receiptFile(context);
  if (!(await fileExists(file))) return checkpoint;
  const parsed = await parseBroadcast(file, context.rpcUrl, CONTRACT_NAMES);
  for (const [key, field] of DEPLOYMENTS) {
    if (parsed.contracts[key] && !sameAddress(parsed.contracts[key].address, checkpoint[field])) return checkpoint;
  }
  const creations = DEPLOYMENTS.map(([key]) => parsed.contracts[key]?.transactionHash).filter(Boolean);
  const transactions = parsed.transactions.filter((transaction) =>
    DEPLOYMENTS.some(([, field]) => sameAddress(transaction.to, checkpoint[field])) || creations.includes(transaction.hash));
  if (!transactions.length) return checkpoint;
  if (transactions.some((transaction) => !transactionSucceeded(context.rpcUrl, transaction.hash))) {
    throw new Error('M003 receipts are not confirmed on this chain');
  }
  const contracts = Object.fromEntries(DEPLOYMENTS.flatMap(([key]) => (parsed.contracts[key] ? [[key, parsed.contracts[key]]] : [])));
  const combined = { ...checkpoint, ...mergeBroadcast(checkpoint, { transactions, contracts }) };
  await writeCheckpoint(context, combined);
  return combined;
}

/** The three CREATE addresses from `owner` at nonces N..N+2. */
function predictAddresses(rpcUrl, owner, deploymentNonce) {
  return Object.fromEntries(DEPLOYMENTS.map(([, field], offset) => {
    const address = cast(rpcUrl, ['compute-address', owner, '--nonce', String(deploymentNonce + offset)]).match(/0x[0-9a-fA-F]{40}/)?.[0];
    if (!address) throw new Error('M003 could not compute deployment address');
    return [field, address];
  }));
}

async function checkDeployed(context, checkpoint, key, field, wiring, artifacts) {
  const { rpcUrl } = context;
  const address = checkpoint[field];
  const found = await findArtifact(artifacts, key);
  if (!found) throw new Error(`M003 missing ${key} artifact; run forge build`);
  const mismatch = compareRuntimeCode(rpcUrl, address, found.artifact);
  if (mismatch) throw new Error(`M003 ${key} ${mismatch}`);
  const reads = { 'owner()(address)': checkpoint.owner, 'pendingOwner()(address)': ZERO, ...wiring };
  for (const [signature, expected] of Object.entries(reads)) {
    if (!sameAddress(call(rpcUrl, address, signature), expected)) throw new Error(`M003 ${key} wiring or ownership mismatch`);
  }
}

async function observe(context) {
  const { rpcUrl, expected, canonical } = context;
  if (chainId(rpcUrl) !== canonical.chainId) throw new Error('M003 wrong RPC chain');
  rejectAuditorList();
  if (!hasCode(rpcUrl, expected.registry) || !hasCode(rpcUrl, expected.identityRegistry) || !hasCode(rpcUrl, expected.sellerPools)
    || !sameAddress(call(rpcUrl, expected.registry, 'identityRegistry()(address)'), expected.identityRegistry)) {
    throw new Error('M003 registry or identity registry mismatch');
  }
  if (!hasCode(rpcUrl, expected.usageAccounting) || !hasCode(rpcUrl, expected.pointsPolicyRegistry)
    || !sameAddress(call(rpcUrl, expected.usageAccounting, 'sellerPools()(address)'), expected.sellerPools)
    || !sameAddress(call(rpcUrl, expected.usageAccounting, 'pointsPolicy()(address)'), expected.pointsPolicyRegistry)) {
    throw new Error('M003 usage accounting or points policy registry mismatch');
  }
  if (!hasCode(rpcUrl, expected.emissionsGate)
    || !sameAddress(call(rpcUrl, expected.usageAccounting, 'emissionsGate()(address)'), expected.emissionsGate)) {
    throw new Error('M003 emissions gate mismatch');
  }
  let checkpoint = await readCheckpoint(context, RELEASE, (record) => ({
    ...record.verificationConfiguration.verificationRegistry,
    sourceCommit: record.sourceCommit, contracts: record.contracts, transactions: record.transactions,
  }));
  if (checkpoint && (!checkpoint.resultsAddress || !checkpoint.kbfAddress || !checkpoint.policyAddress)) {
    throw new Error(`M003 checkpoint ${context.checkpointFile} is not a ${RELEASE} checkpoint (an earlier M003 release?); move it aside`);
  }
  if (!checkpoint) {
    // The earlier split release used the same ledger keys; only this release's own entries need a history record.
    if (canonical.release === RELEASE && DEPLOYMENTS.some(([key]) => canonical.contracts[key])) {
      throw new Error('M003 verification exists without its history record');
    }
    const file = receiptFile(context);
    if (await fileExists(file)) {
      const broadcast = await readJson(file);
      if (broadcast.transactions?.some((transaction) => Object.hasOwn(CONTRACT_NAMES, transaction.contractName))) {
        throw new Error('M003 prior broadcast exists; restore its checkpoint or history before continuing');
      }
    }
    const owner = verificationOwner();
    const deploymentNonce = numberValue(cast(rpcUrl, ['nonce', owner]));
    checkpoint = {
      ...expected, owner, deploymentNonce, ...predictAddresses(rpcUrl, owner, deploymentNonce),
      bonusBps: parseBonusBps(process.env.VERIFICATION_BONUS_BPS),
      sourceCommit: sourceCommit(), contracts: {}, transactions: [],
    };
  } else {
    if (!sameAddress(checkpoint.registry, expected.registry) || !sameAddress(checkpoint.identityRegistry, expected.identityRegistry)
      || !sameAddress(checkpoint.sellerPools, expected.sellerPools)
      || !sameAddress(checkpoint.usageAccounting, expected.usageAccounting)
      || !sameAddress(checkpoint.pointsPolicyRegistry, expected.pointsPolicyRegistry)
      || !sameAddress(checkpoint.emissionsGate, expected.emissionsGate)) {
      throw new Error('M003 checkpoint baseline mismatch');
    }
    if (process.env.VERIFICATION_BONUS_BPS !== undefined
      && parseBonusBps(process.env.VERIFICATION_BONUS_BPS) !== checkpoint.bonusBps) {
      throw new Error('M003 bonus differs from the original deployment; change it on the policy instead');
    }
    checkpoint = await collectReceipts(context, checkpoint);
  }
  if (process.env.VERIFICATION_OWNER !== undefined && !sameAddress(verificationOwner(), checkpoint.owner)) {
    throw new Error('M003 VERIFICATION_OWNER differs from the original deployment');
  }
  // Contracts deploy in nonce order, so the deployed ones are a prefix; the rest must still be sendable.
  const deployed = DEPLOYMENTS.map(([, field]) => hasCode(rpcUrl, checkpoint[field]));
  const count = deployed.filter(Boolean).length;
  if (deployed.some((present, index) => present !== index < count)
    || DEPLOYMENTS.slice(count).some(([key]) => checkpoint.contracts[key])
    || (count < DEPLOYMENTS.length
      && numberValue(cast(rpcUrl, ['nonce', checkpoint.owner, '--block', 'pending'])) !== checkpoint.deploymentNonce + count)) {
    throw new Error('M003 deployment is missing or its nonce is in use; reconcile the original broadcast');
  }
  const wiring = {
    verificationResults: { 'emissionsGate()(address)': expected.emissionsGate },
    kbfAudits: {
      'results()(address)': checkpoint.resultsAddress, 'sellerPools()(address)': expected.sellerPools,
      'identityRegistry()(address)': expected.identityRegistry,
    },
    verificationPointsPolicy: { 'results()(address)': checkpoint.resultsAddress, 'usageAccounting()(address)': checkpoint.usageAccounting },
  };
  // One artifact index per observation, built only when something is deployed.
  const artifacts = count > 0 ? await buildArtifactIndex() : null;
  for (const [key, field] of DEPLOYMENTS.slice(0, count)) {
    await checkDeployed(context, checkpoint, key, field, wiring[key], artifacts);
  }
  for (const [key] of DEPLOYMENTS.slice(0, count)) {
    if (!checkpoint.contracts[key]) throw new Error(`M003 restore confirmed ${key} deployment receipts before continuing`);
  }
  let state = 'ready';
  if (count === DEPLOYMENTS.length) {
    const isAudit = call(rpcUrl, checkpoint.resultsAddress, 'isAudit(address)(bool)', [checkpoint.kbfAddress]);
    const share = numberValue(call(rpcUrl, checkpoint.resultsAddress, 'auditShareBps(address)(uint16)', [checkpoint.kbfAddress]));
    if (String(isAudit) === 'true' && share === KBF_SHARE_BPS) state = 'active';
  }
  // Approving auditors, the minter controller and registering the policy are manual steps outside M003.
  return { state, deployment: { checkpoint } };
}

export function activationRecords(context, checkpoint) {
  const { sourceCommit: commit, contracts, transactions, ...configuration } = checkpoint;
  const verificationConfiguration = {
    ...context.canonical.verificationConfiguration, verificationRegistry: configuration,
  };
  const record = buildReleaseRecord(context, {
    release: RELEASE, status: 'active', sourceCommit: commit, contracts, transactions, verificationConfiguration,
    notes: POLICY_NOTE,
  });
  const current = applyContractAliases(structuredClone(context.canonical), contracts, {});
  Object.assign(current, { release: RELEASE, status: 'active', sourceCommit: commit, transactions, verificationConfiguration, notes: POLICY_NOTE });
  return { record, current };
}

async function finalize(context, observation, mode) {
  if (mode !== 'broadcast' || observation.state !== 'active') return false;
  const checkpoint = observation.deployment.checkpoint;
  if (await historyRecordExists(context, RELEASE)
    && sameAddress(context.canonical.contracts.kbfAudits?.address, checkpoint.kbfAddress)) {
    await clearPlan(context, RELEASE);
    return false;
  }
  if (DEPLOYMENTS.some(([key]) => !checkpoint.contracts[key]?.transactionHash)) {
    throw new Error('M003 confirmed creation receipts required');
  }
  const { record, current } = activationRecords(context, checkpoint);
  if (recordErrors(record).length) throw new Error(recordErrors(record).join('\n'));
  if (await historyRecordExists(context, RELEASE)) {
    const recorded = await readJson(historyFile(context, RELEASE));
    if (!sameAddress(recorded.contracts.kbfAudits?.address, checkpoint.kbfAddress)) throw new Error('M003 history address mismatch');
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
      ...Object.fromEntries(DEPLOYMENTS.map(([key, field]) => [`current.contracts.${key}`, {
        before: context.canonical.contracts[key]?.address ?? 'not deployed',
        after: observation.deployment.checkpoint[field],
      }])),
      'verificationResults.audits': { before: 'none', after: 'kbfAudits at 10000 bps' },
      'pointsPolicyRegistry.policies': {
        before: 'unchanged',
        after: 'unchanged (register the policy manually later)',
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
  // Earlier M003 releases kept their checkpoints at `.deployments/m003-<network>.json` (single
  // AntseedKbfVerification) and `m003-verification-split-<network>.json`; this release must not read them.
  checkpointName: 'm003-verification-audits',
  networks: ['base-sepolia', 'base-mainnet'],
  releases: [RELEASE],
  phases: [deployPhase],
  validateOptions(options) {
    if (!this.networks.includes(options.network) || (options.mode === 'fork-test' && options.network !== 'base-mainnet')) {
      throw new Error('M003 supports Base Sepolia/mainnet dry-run/broadcast and Base mainnet fork-test');
    }
  },
  validateBaseline,
  expectedState: (canonical) => ({
    registry: canonical.contracts.registry.address,
    identityRegistry: canonical.contracts.identityRegistry.address,
    sellerPools: canonical.contracts.sellerPools.address,
    usageAccounting: canonical.contracts.usageAccounting.address,
    pointsPolicyRegistry: canonical.contracts.pointsPolicyRegistry.address,
    emissionsGate: canonical.contracts.emissionsGate.address,
  }),
  observe,
  printStatus: (observation) => console.log(`M003 state: ${observation.state}`),
  expectedSigner: (_role, _context, observation) => observation.deployment.checkpoint.owner,
  environment(context, observation, signers, extra = {}) {
    const checkpoint = observation.deployment.checkpoint;
    return {
      ...process.env, ...extra, EXPECTED_CHAIN_ID: String(context.canonical.chainId),
      ANTSEED_REGISTRY: checkpoint.registry, EXPECTED_IDENTITY_REGISTRY: checkpoint.identityRegistry,
      SELLER_POOLS: checkpoint.sellerPools, USAGE_ACCOUNTING: checkpoint.usageAccounting,
      POINTS_POLICY_REGISTRY: checkpoint.pointsPolicyRegistry,
      VERIFICATION_BONUS_BPS: String(checkpoint.bonusBps),
      VERIFICATION_OWNER: signers.verificationOwner, VERIFICATION_DEPLOYMENT_NONCE: String(checkpoint.deploymentNonce),
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
      // Anvil account 1: a deployer that owns neither the protocol registry nor the points registry.
      const owner = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
      const overrides = { signers: { verificationOwner: `unlocked:${owner}` } };
      const previous = process.env.VERIFICATION_OWNER;
      process.env.VERIFICATION_OWNER = owner;
      let first;
      let second;
      try {
        first = await drive(overrides);
        second = await drive(overrides);
      } finally {
        if (previous === undefined) delete process.env.VERIFICATION_OWNER;
        else process.env.VERIFICATION_OWNER = previous;
      }
      if (first.state !== 'active' || second.state !== 'active'
        || DEPLOYMENTS.some(([, field]) => !sameAddress(first.deployment.checkpoint[field], second.deployment.checkpoint[field]))
        || first.deployment.checkpoint.transactions.length !== second.deployment.checkpoint.transactions.length) {
        throw new Error('M003 rehearsal must deploy once and repeat as an active no-op');
      }
    },
  },
  run: (options, overrides) => runMigration(migration, options, overrides),
};

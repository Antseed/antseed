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

export const RELEASE = '003-kbf-verification';
export const POLICY_NOTE = 'M003 deploys the KBF verification contract and its points policy only. The policy is not '
  + 'registered in the points policy registry by M003; the registry owner registers it separately, so verdicts change '
  + 'no seller points until then.';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const CONTRACT_NAMES = { AntseedKbfVerification: 'kbfVerification', AntseedKbfVerificationPointsPolicy: 'kbfVerificationPointsPolicy' };
export const DEFAULT_BONUS_BPS = 0;
const MAX_BONUS_BPS = 5_000;
const TARGET = 'script/migrations/M003VerificationRegistry/Deploy.s.sol:M003DeployVerificationRegistry';

function receiptFile(context, simulated = false) {
  const file = (simulated ? simulationPath : broadcastPath)('Deploy.s.sol', context.canonical.chainId);
  return context.forkTest ? path.join(context.receiptDirectory, path.relative(CONTRACTS_ROOT, file)) : file;
}

/** The KBF deploy never approves verifiers; the owner does that separately with setVerifier after the deploy. */
export function rejectAuditorList(value = process.env.VERIFICATION_AUDITORS) {
  if (value !== undefined && value.trim() !== '') {
    throw new Error('The KBF verification deploy does not approve verifiers; unset VERIFICATION_AUDITORS and approve them separately with setVerifier');
  }
}

/**
 * The wallet that deploys and owns both contracts. M003 only deploys, so it need not own the
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
  for (const name of ['registry', 'identityRegistry', 'sellerPools', 'usageAccounting', 'pointsPolicyRegistry']) {
    if (!ADDRESS.test(canonical.contracts?.[name]?.address ?? '')) throw new Error(`KBF verification deploy missing ${name}`);
  }
}

/**
 * Deploys AntseedKbfVerification and its points policy for one release. M003 deployed the
 * single-auditor contract; M004 deploys the round contract from the same script and replaces it
 * as the current verification contract, leaving the M003 history record untouched.
 */
export function kbfVerificationMigration({ id, release: RELEASE, replaces = null, note: POLICY_NOTE }) {
  /** Lower-cased addresses the replaced release created; empty when nothing is replaced. */
  async function replacedAddresses(context) {
    if (!replaces || !(await historyRecordExists(context, replaces))) return new Set();
    const previous = await readJson(historyFile(context, replaces));
    return new Set(Object.values(previous.contracts ?? {}).map((contract) => contract.address?.toLowerCase()).filter(Boolean));
  }

  function recordErrors(record) {
    const config = record.verificationConfiguration?.verificationRegistry;
    const contract = record.contracts?.kbfVerification;
    const policy = record.contracts?.kbfVerificationPointsPolicy;
    if (!config || !contract || !policy) return [`${id} requires verification contracts and configuration`];
    const errors = [];
    for (const key of ['registry', 'identityRegistry', 'sellerPools', 'usageAccounting', 'pointsPolicyRegistry', 'owner', 'address', 'policyAddress']) {
      if (!ADDRESS.test(config[key] ?? '') || sameAddress(config[key], ZERO)) errors.push(`${id} invalid ${key}`);
    }
    if (!sameAddress(contract.address, config.address)) errors.push(`${id} verification address mismatch`);
    if (!sameAddress(contract.owner, config.owner)) errors.push(`${id} verification owner mismatch`);
    if (contract.constructorArguments?.length !== 2 || !sameAddress(contract.constructorArguments[0], config.registry)
      || !sameAddress(contract.constructorArguments[1], config.sellerPools)) {
      errors.push(`${id} verification constructor mismatch`);
    }
    if (!sameAddress(policy.address, config.policyAddress)) errors.push(`${id} points policy address mismatch`);
    if (!sameAddress(policy.owner, config.owner)) errors.push(`${id} points policy owner mismatch`);
    const policyArguments = policy.constructorArguments ?? [];
    if (policyArguments.length !== 4 || !sameAddress(policyArguments[0], config.address)
      || !sameAddress(policyArguments[1], config.usageAccounting) || String(policyArguments[2]) !== String(config.bonusBps)
      || !sameAddress(policyArguments[3], config.owner)) {
      errors.push(`${id} points policy constructor mismatch`);
    }
    try { parseBonusBps(String(config.bonusBps)); } catch (error) { errors.push(error.message); }
    if (!Number.isSafeInteger(config.deploymentNonce) || config.deploymentNonce < 0) errors.push(`${id} invalid nonce`);
    if (config.auditors !== undefined) errors.push(`${id} records no auditors`);
    return errors;
  }

  async function collectReceipts(context, checkpoint) {
    const file = receiptFile(context);
    if (!(await fileExists(file))) return checkpoint;
    const parsed = await parseBroadcast(file, context.rpcUrl, CONTRACT_NAMES);
    const creation = parsed.contracts.kbfVerification;
    const policyCreation = parsed.contracts.kbfVerificationPointsPolicy;
    if (creation && !sameAddress(creation.address, checkpoint.address)) return checkpoint;
    if (policyCreation && !sameAddress(policyCreation.address, checkpoint.policyAddress)) return checkpoint;
    const transactions = parsed.transactions.filter((transaction) =>
      sameAddress(transaction.to, checkpoint.address) || sameAddress(transaction.to, checkpoint.policyAddress)
      || transaction.hash === creation?.transactionHash || transaction.hash === policyCreation?.transactionHash);
    if (!transactions.length) return checkpoint;
    if (transactions.some((transaction) => !transactionSucceeded(context.rpcUrl, transaction.hash))) {
      throw new Error(`${id} receipts are not confirmed on this chain`);
    }
    const combined = { ...checkpoint, ...mergeBroadcast(checkpoint, {
      transactions, contracts: {
        ...(creation ? { kbfVerification: creation } : {}),
        ...(policyCreation ? { kbfVerificationPointsPolicy: policyCreation } : {}),
      },
    }) };
    await writeCheckpoint(context, combined);
    return combined;
  }

  async function observe(context) {
    const { rpcUrl, expected, canonical } = context;
    if (chainId(rpcUrl) !== canonical.chainId) throw new Error(`${id} wrong RPC chain`);
    rejectAuditorList();
    if (!hasCode(rpcUrl, expected.registry) || !hasCode(rpcUrl, expected.identityRegistry) || !hasCode(rpcUrl, expected.sellerPools)
      || !sameAddress(call(rpcUrl, expected.registry, 'identityRegistry()(address)'), expected.identityRegistry)) {
      throw new Error(`${id} registry or identity registry mismatch`);
    }
    if (!hasCode(rpcUrl, expected.usageAccounting) || !hasCode(rpcUrl, expected.pointsPolicyRegistry)
      || !sameAddress(call(rpcUrl, expected.usageAccounting, 'sellerPools()(address)'), expected.sellerPools)
      || !sameAddress(call(rpcUrl, expected.usageAccounting, 'pointsPolicy()(address)'), expected.pointsPolicyRegistry)) {
      throw new Error(`${id} usage accounting or points policy registry mismatch`);
    }
    let checkpoint = await readCheckpoint(context, RELEASE, (record) => ({
      ...record.verificationConfiguration.verificationRegistry,
      sourceCommit: record.sourceCommit, contracts: record.contracts, transactions: record.transactions,
    }));
    if (!checkpoint) {
      const replaced = await replacedAddresses(context);
      if (canonical.contracts.kbfVerification && !replaced.has(canonical.contracts.kbfVerification.address.toLowerCase())) {
        throw new Error(`${id} verification exists without its history record`);
      }
      const file = receiptFile(context);
      if (await fileExists(file)) {
        const broadcast = await readJson(file);
        // The replaced release's own broadcast (same deploy script) is not a lost deployment of this one.
        if (broadcast.transactions?.some((transaction) => Object.hasOwn(CONTRACT_NAMES, transaction.contractName)
          && !replaced.has(String(transaction.contractAddress ?? '').toLowerCase()))) {
          throw new Error(`${id} prior broadcast exists; restore its checkpoint or history before continuing`);
        }
      }
      const owner = verificationOwner();
      const deploymentNonce = numberValue(cast(rpcUrl, ['nonce', owner]));
      const address = cast(rpcUrl, ['compute-address', owner, '--nonce', String(deploymentNonce)]).match(/0x[0-9a-fA-F]{40}/)?.[0];
      const policyAddress = cast(rpcUrl, ['compute-address', owner, '--nonce', String(deploymentNonce + 1)]).match(/0x[0-9a-fA-F]{40}/)?.[0];
      if (!address || !policyAddress) throw new Error(`${id} could not compute deployment address`);
      checkpoint = {
        ...expected, owner, deploymentNonce, address, policyAddress,
        bonusBps: parseBonusBps(process.env.VERIFICATION_BONUS_BPS),
        sourceCommit: sourceCommit(), contracts: {}, transactions: [],
      };
    } else {
      if (!sameAddress(checkpoint.registry, expected.registry) || !sameAddress(checkpoint.identityRegistry, expected.identityRegistry)
        || !sameAddress(checkpoint.sellerPools, expected.sellerPools)
        || !sameAddress(checkpoint.usageAccounting, expected.usageAccounting)
        || !sameAddress(checkpoint.pointsPolicyRegistry, expected.pointsPolicyRegistry)) {
        throw new Error(`${id} checkpoint baseline mismatch`);
      }
      if (process.env.VERIFICATION_BONUS_BPS !== undefined
        && parseBonusBps(process.env.VERIFICATION_BONUS_BPS) !== checkpoint.bonusBps) {
        throw new Error(`${id} bonus differs from the original deployment; change it on the policy instead`);
      }
      checkpoint = await collectReceipts(context, checkpoint);
    }
    if (process.env.VERIFICATION_OWNER !== undefined && !sameAddress(verificationOwner(), checkpoint.owner)) {
      throw new Error(`${id} VERIFICATION_OWNER differs from the original deployment`);
    }
    const verification = checkpoint.address;
    const policy = checkpoint.policyAddress;
    let state = 'ready';
    if (hasCode(rpcUrl, verification)) {
      const found = await findArtifact(await buildArtifactIndex(), 'kbfVerification');
      if (!found) throw new Error(`${id} missing AntseedKbfVerification artifact; run forge build`);
      const mismatch = compareRuntimeCode(rpcUrl, verification, found.artifact);
      if (mismatch) throw new Error(`${id} ${mismatch}`);
      if (!sameAddress(call(rpcUrl, verification, 'registry()(address)'), expected.registry)
        || !sameAddress(call(rpcUrl, verification, 'sellerPools()(address)'), expected.sellerPools)
        || !sameAddress(call(rpcUrl, verification, 'owner()(address)'), checkpoint.owner)
        || !sameAddress(call(rpcUrl, verification, 'pendingOwner()(address)'), ZERO)) {
        throw new Error(`${id} verification registry or ownership mismatch`);
      }
      if (!checkpoint.contracts.kbfVerification) throw new Error(`${id} restore confirmed deployment receipts before continuing`);
      state = await observePolicy(context, checkpoint) ? 'active' : 'ready';
    } else if (checkpoint.contracts.kbfVerification || hasCode(rpcUrl, policy)
      || numberValue(cast(rpcUrl, ['nonce', checkpoint.owner, '--block', 'pending'])) !== checkpoint.deploymentNonce) {
      throw new Error(`${id} deployment is missing or its nonce is in use; reconcile the original broadcast`);
    }
    return { state, deployment: { checkpoint } };
  }

  async function observePolicy(context, checkpoint) {
    const { rpcUrl } = context;
    const policy = checkpoint.policyAddress;
    if (!hasCode(rpcUrl, policy)) {
      if (checkpoint.contracts.kbfVerificationPointsPolicy
        || numberValue(cast(rpcUrl, ['nonce', checkpoint.owner, '--block', 'pending'])) !== checkpoint.deploymentNonce + 1) {
        throw new Error(`${id} points policy is missing or its nonce is in use; reconcile the original broadcast`);
      }
      return false;
    }
    const found = await findArtifact(await buildArtifactIndex(), 'kbfVerificationPointsPolicy');
    if (!found) throw new Error(`${id} missing AntseedKbfVerificationPointsPolicy artifact; run forge build`);
    const mismatch = compareRuntimeCode(rpcUrl, policy, found.artifact);
    if (mismatch) throw new Error(`${id} points policy ${mismatch}`);
    if (!sameAddress(call(rpcUrl, policy, 'verification()(address)'), checkpoint.address)
      || !sameAddress(call(rpcUrl, policy, 'usageAccounting()(address)'), checkpoint.usageAccounting)
      || !sameAddress(call(rpcUrl, policy, 'owner()(address)'), checkpoint.owner)
      || !sameAddress(call(rpcUrl, policy, 'pendingOwner()(address)'), ZERO)) {
      throw new Error(`${id} points policy wiring or ownership mismatch`);
    }
    if (!checkpoint.contracts.kbfVerificationPointsPolicy) throw new Error(`${id} restore confirmed policy deployment receipts before continuing`);
    // Registering the policy in the points policy registry is a manual step outside M003.
    return true;
  }

  function activationRecords(context, checkpoint) {
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
      && sameAddress(context.canonical.contracts.kbfVerification?.address, checkpoint.address)) {
      await clearPlan(context, RELEASE);
      return false;
    }
    if (!checkpoint.contracts.kbfVerification?.transactionHash || !checkpoint.contracts.kbfVerificationPointsPolicy?.transactionHash) {
      throw new Error(`${id} confirmed creation receipts required`);
    }
    const { record, current } = activationRecords(context, checkpoint);
    if (recordErrors(record).length) throw new Error(recordErrors(record).join('\n'));
    if (await historyRecordExists(context, RELEASE)) {
      const recorded = await readJson(historyFile(context, RELEASE));
      if (!sameAddress(recorded.contracts.kbfVerification.address, checkpoint.address)) throw new Error(`${id} history address mismatch`);
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
        'current.contracts.kbfVerification': {
          before: context.canonical.contracts.kbfVerification?.address ?? 'not deployed',
          after: observation.deployment.checkpoint.address,
        },
        'current.contracts.kbfVerificationPointsPolicy': {
          before: context.canonical.contracts.kbfVerificationPointsPolicy?.address ?? 'not deployed',
          after: observation.deployment.checkpoint.policyAddress,
        },
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
        if (after.state !== 'active') throw new Error(`${id} deployment did not complete`);
        await finalize(context, after, mode);
      }
    },
  };

  const migration = {
    id,
    networks: ['base-sepolia', 'base-mainnet'],
    releases: [RELEASE],
    phases: [deployPhase],
    validateOptions(options) {
      if (!this.networks.includes(options.network) || (options.mode === 'fork-test' && options.network !== 'base-mainnet')) {
        throw new Error(`${id} supports Base Sepolia/mainnet dry-run/broadcast and Base mainnet fork-test`);
      }
    },
    validateBaseline,
    expectedState: (canonical) => ({
      registry: canonical.contracts.registry.address,
      identityRegistry: canonical.contracts.identityRegistry.address,
      sellerPools: canonical.contracts.sellerPools.address,
      usageAccounting: canonical.contracts.usageAccounting.address,
      pointsPolicyRegistry: canonical.contracts.pointsPolicyRegistry.address,
    }),
    observe,
    printStatus: (observation) => console.log(`${id} state: ${observation.state}`),
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
      if (!sameAddress(environment.VERIFICATION_OWNER, observation.deployment.checkpoint.owner)) throw new Error(`${id} wrong verificationOwner signer`);
      if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], environment);
    },
    finalize,
    idleMessage: () => `${id} already active; no transactions required.`,
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
          || !sameAddress(first.deployment.checkpoint.address, second.deployment.checkpoint.address)
          || !sameAddress(first.deployment.checkpoint.policyAddress, second.deployment.checkpoint.policyAddress)
          || first.deployment.checkpoint.transactions.length !== second.deployment.checkpoint.transactions.length) {
          throw new Error(`${id} rehearsal must deploy once and repeat as an active no-op`);
        }
      },
    },
    run: (options, overrides) => runMigration(migration, options, overrides),
  };

  return { migration, recordErrors, activationRecords };
}

const m003 = kbfVerificationMigration({ id: 'M003', release: RELEASE, note: POLICY_NOTE });
export const { migration, recordErrors, activationRecords } = m003;

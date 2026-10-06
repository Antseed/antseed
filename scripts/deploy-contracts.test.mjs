import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fsPromises, { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { broadcastPath, mergeBroadcast, parseBroadcast, runForgeScript } from './deployments/runtime/foundry.mjs';

import {
  buildMigrationRegistry,
  buildReleaseOwners,
  deploymentMigrations,
  getDeploymentMigration,
  parseDeployArgs,
} from './deployments/index.mjs';
import {
  buildActivationRecord,
  classifyM001,
  migration,
  shouldRunM001Cutover,
  validateM001Baseline,
  validateM001Options,
} from './deployments/m001.mjs';
import {
  classifyM002,
  DEFAULT_RELEASE_BPS,
  migration as m002,
  validateM002Baseline,
  validateM002Options,
} from './deployments/m002.mjs';
import { writeJsonAtomic, writeJsonOnce } from './deployments/runtime/artifacts.mjs';
import { applyContractAliases, buildReleaseRecord, currentRelease, historyRecordExists, loadContext, readCheckpoint, validateArtifacts, writeActivationRecords } from './deployments/runtime/ledger.mjs';
import { executePhases, runMigration } from './deployments/runtime/runner.mjs';
import { withAnvilFork } from './deployments/runtime/anvil.mjs';
import { resolveRehearsal, runRehearsal } from './deployments/runtime/rehearsal.mjs';
import { CANONICAL_DEPLOYMENTS_ROOT, CONTRACTS_ROOT } from './deployments/runtime/paths.mjs';
import {
  PAUSE_LEAD_SECONDS,
  cutoverSchedule,
  pauseDecision,
  runCutover,
  verifyPointers,
} from './deployments/m001-cutover.mjs';
import { recordErrors } from './validate-contract-deployments.mjs';
import { assertSignerOwners, parseSignerSpecs, resolveSigners, signerEnvironment } from './deployments/runtime/signers.mjs';
import { parseSandboxArgs } from './m001-sandbox.mjs';
import { renderNetwork } from './generate-contract-chain-config.mjs';

const ADDRESS = {
  registry: '0x0000000000000000000000000000000000000001',
  ants: '0x0000000000000000000000000000000000000002',
  channels: '0x0000000000000000000000000000000000000003',
  legacyEmissions: '0x0000000000000000000000000000000000000004',
  legacyStaking: '0x0000000000000000000000000000000000000005',
  usageAccounting: '0x0000000000000000000000000000000000000006',
  sellerRegistry: '0x0000000000000000000000000000000000000007',
  sellerRewardsPool: '0x00000000000000000000000000000000000000ee',
};

const REHEARSAL_FORK = { rpcEnv: 'ANTSEED_TEST_FORK_RPC_URL', forkBlockNumber: 123, chainId: 8453 };
const REHEARSAL_OPTIONS = { migration: 'M004', network: 'base-mainnet', mode: 'fork-test', signers: {} };

function rehearsalMigration(id, prerequisites = [], fork) {
  return { id, rehearsal: { prerequisites, fork, async run() {} } };
}

test('resolves rehearsal prerequisites once, in order, inheriting the pinned fork', () => {
  const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
  const second = rehearsalMigration('M002', ['M001']);
  const third = rehearsalMigration('M003', ['M001']);
  const target = rehearsalMigration('M004', ['M002', 'M003']);
  const registry = new Map([first, second, third, target].map((entry) => [entry.id, entry]));
  const result = resolveRehearsal(target, REHEARSAL_OPTIONS, registry);
  assert.deepEqual(result.migrations.map((entry) => entry.id), ['M001', 'M002', 'M003', 'M004']);
  assert.deepEqual(result.fork, REHEARSAL_FORK);
  assert.deepEqual(resolveRehearsal(first, REHEARSAL_OPTIONS, registry).migrations, [first]);
});

test('rejects invalid rehearsal declarations before loading environment or starting Anvil', async () => {
  const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
  const registry = new Map([[first.id, first]]);
  const cases = [
    [rehearsalMigration('M002', ['M009']), /unknown rehearsal prerequisite M009/],
    [rehearsalMigration('M002', ['M002']), /Cyclic rehearsal prerequisite/],
    [{ id: 'M002' }, /no rehearsal hook/],
    [rehearsalMigration('M002', 'M001'), /prerequisites must be an array/],
    [rehearsalMigration('M002'), /no rehearsal fork configuration/],
    [rehearsalMigration('M002', [], { ...REHEARSAL_FORK, forkBlockNumber: undefined }), /pinned rehearsal fork/],
    [rehearsalMigration('M002', ['M001'], { ...REHEARSAL_FORK, chainId: 1 }), /fork conflicts/],
  ];
  for (const [target, expected] of cases) {
    registry.set(target.id, target);
    await assert.rejects(runRehearsal(target, REHEARSAL_OPTIONS, {
      registry,
      runMigration() { assert.fail('must not drive a migration'); },
    }, {
      loadDotEnv() { assert.fail('must validate before loading environment'); },
      withAnvilFork() { assert.fail('must not start Anvil'); },
    }), expected);
  }
  first.rehearsal.prerequisites = ['M002'];
  const target = rehearsalMigration('M002', ['M001']);
  registry.set(target.id, target);
  assert.throws(() => resolveRehearsal(target, REHEARSAL_OPTIONS, registry), /Cyclic rehearsal prerequisite/);
});

test('validates the network for prerequisite rehearsals and preserves M001 standalone configuration', () => {
  const target = rehearsalMigration('M002', ['M001']);
  const registry = new Map([[migration.id, migration]]);
  assert.throws(() => resolveRehearsal(target, {
    ...REHEARSAL_OPTIONS, network: 'base-sepolia',
  }, registry), /Base Sepolia.*Base mainnet.*fork-test/);
  const result = resolveRehearsal(migration, { ...REHEARSAL_OPTIONS, migration: 'M001' }, registry);
  assert.deepEqual(result.migrations, [migration]);
  assert.equal(result.fork.rpcEnv, 'BASE_MAINNET_RPC_URL');
  assert.equal(result.fork.forkBlockNumber, 50_571_469);
  assert.equal(result.fork.chainId, 8453);
});

test('M001 rehearsal retains its fixtures, epoch advancement, activation, and no-op check', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-m001-hook-'));
  const calls = [];
  const driven = [];
  const previousVerifier = process.env.SP1_VERIFIER;
  delete process.env.SP1_VERIFIER;
  t.after(async () => {
    if (previousVerifier === undefined) delete process.env.SP1_VERIFIER;
    else process.env.SP1_VERIFIER = previousVerifier;
    await rm(directory, { recursive: true, force: true });
  });
  await writeJsonAtomic(path.join(directory, 'base-mainnet', 'current.json'), {
    network: 'base-mainnet',
    contracts: Object.fromEntries(['registry', 'antsToken', 'channels', 'emissions', 'staking']
      .map((key) => [key, { address: ADDRESS.registry }])),
  });
  mockCast(t, (args) => {
    assert.ok(args.includes('http://127.0.0.1:9999'));
    calls.push(args);
    if (args.includes('--create')) return JSON.stringify({ contractAddress: ADDRESS.channels });
    return ADDRESS.registry;
  });
  await migration.rehearsal.run({
    rpcUrl: 'http://127.0.0.1:9999',
    outputRoot: directory,
    network: 'base-mainnet',
    async runMigration(overrides) {
      driven.push(overrides);
      return driven.length === 1
        ? { state: 'awaiting-epoch', deployment: { checkpoint: { cutoverTimestamp: 2000 } } }
        : { state: 'active' };
    },
  });
  assert.equal(driven.length, 3);
  assert.ok(driven.every((overrides) => overrides === driven[0]));
  assert.equal(driven[0].environment.SP1_VERIFIER, ADDRESS.channels);
  assert.equal(driven[0].environment.SP1_VERIFIER_HASH, `0x${'0'.repeat(63)}1`);
  assert.equal(driven[0].environment.WASH_TRADING_REGISTRY, undefined);
  assert.deepEqual(Object.keys(driven[0].signers), [
    'deployer', 'registryOwner', 'channelsOwner', 'sellerRewardsPoolOwner', 'diemStaker',
  ]);
  assert.ok(Object.values(driven[0].signers).every((signer) => signer.startsWith('unlocked:')));
  assert.equal(calls.filter((args) => args.includes('transferOwnership(address)')).length, 5);
  assert.ok(calls.some((args) => args[1] === 'anvil_setNextBlockTimestamp' && args[2] === '2001'));
  assert.ok(calls.some((args) => args[1] === 'anvil_impersonateAccount'
    && `unlocked:${args[2]}` === driven[0].signers.diemStaker));
});

for (const failPrerequisite of [false, true]) {
  test(`rehearsals isolate their ledger and clean up Anvil on ${failPrerequisite ? 'failure' : 'success'}`, async (t) => {
    const canonicalRoot = await mkdtemp(path.join(tmpdir(), 'antseed-rehearsal-baseline-'));
    const logs = [];
    const calls = [];
    let outputRoot;
    let stopped = false;
    let environmentLoaded = false;
    const previousRpc = process.env[REHEARSAL_FORK.rpcEnv];
    delete process.env[REHEARSAL_FORK.rpcEnv];
    t.mock.method(console, 'log', (message) => logs.push(message));
    t.after(async () => {
      if (previousRpc === undefined) delete process.env[REHEARSAL_FORK.rpcEnv];
      else process.env[REHEARSAL_FORK.rpcEnv] = previousRpc;
      await rm(canonicalRoot, { recursive: true, force: true });
      if (outputRoot) await rm(outputRoot, { recursive: true, force: true });
    });
    const baseline = { release: '000-baseline', network: 'base-mainnet' };
    const canonicalFile = path.join(canonicalRoot, 'base-mainnet', 'current.json');
    await writeJsonAtomic(canonicalFile, baseline);
    const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
    const second = rehearsalMigration('M002', ['M001']);
    for (const current of [first, second]) {
      current.expectedState = (canonical) => canonical;
      current.rehearsal.run = async (context) => {
        outputRoot ??= context.outputRoot;
        assert.equal(context.outputRoot, outputRoot);
        assert.equal(context.rpcUrl, 'http://127.0.0.1:9999');
        assert.equal(context.network, 'base-mainnet');
        await context.runMigration({
          signers: { deployer: `unlocked:${ADDRESS.registry}` },
          environment: { FIXTURE: current.id },
          rpcUrl: 'https://must-not-be-used',
          outputRoot: canonicalRoot,
          canonicalRoot,
          forkTest: false,
        });
        if (failPrerequisite && current.id === 'M001') throw new Error('prerequisite failed');
      };
    }
    const run = runRehearsal(second, {
      ...REHEARSAL_OPTIONS, migration: 'M002', signers: { deployer: 'account:live-wallet' },
    }, {
      registry: new Map([[first.id, first], [second.id, second]]),
      async runMigration(current, options, overrides) {
        assert.equal(environmentLoaded, true);
        assert.equal(options.mode, 'broadcast');
        assert.equal(options.migration, current.id);
        assert.deepEqual(options.signers, {});
        assert.equal(overrides.rpcUrl, 'http://127.0.0.1:9999');
        assert.equal(overrides.forkTest, true);
        assert.equal(overrides.outputRoot, outputRoot);
        assert.equal(overrides.canonicalRoot, outputRoot);
        assert.notEqual(outputRoot, canonicalRoot);
        assert.equal(overrides.environment.FIXTURE, current.id);
        assert.deepEqual(overrides.signers, { deployer: `unlocked:${ADDRESS.registry}` });
        const context = await loadContext(current, options.network, overrides);
        assert.equal(context.canonical.release, calls.length ? 'M001-active' : '000-baseline');
        if (calls.length) {
          assert.equal(await historyRecordExists(context, 'M001-active'), true);
        }
        calls.push(current.id);
        await writeJsonAtomic(path.join(outputRoot, options.network, 'current.json'), { release: `${current.id}-active` });
        await writeJsonOnce(path.join(outputRoot, options.network, 'history', `${current.id}-active.json`), { release: `${current.id}-active` });
      },
    }, {
      canonicalRoot,
      async loadDotEnv() {
        environmentLoaded = true;
        process.env[REHEARSAL_FORK.rpcEnv] = 'https://test-fork-source';
      },
      withAnvilFork: (request, body) => withAnvilFork(request, body, {
        availablePort: async () => 9999,
        spawn(command, args) {
          assert.equal(environmentLoaded, true);
          assert.equal(command, 'anvil');
          assert.ok(args.includes('https://test-fork-source'));
          assert.ok(args.includes('123'));
          return { kill(signal) { assert.equal(signal, 'SIGTERM'); stopped = true; } };
        },
        waitForAnvil: async () => {},
      }),
    });
    if (failPrerequisite) await assert.rejects(run, /prerequisite failed/);
    else await run;
    assert.equal(stopped, true);
    assert.deepEqual(calls, failPrerequisite ? ['M001'] : ['M001', 'M002']);
    assert.deepEqual(JSON.parse(await readFile(canonicalFile, 'utf8')), baseline);
    assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'base-mainnet', 'current.json'), 'utf8')).release,
      failPrerequisite ? 'M001-active' : 'M002-active');
    assert.ok(logs.some((message) => message.includes(outputRoot)));
    assert.equal(logs.some((message) => message.includes('fork test passed')), !failPrerequisite);
  });
}

test('temporary canonical roots never regenerate repository chain configuration', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, root: options.env.CONTRACT_DEPLOYMENTS_ROOT });
    return { status: 0, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const temporary = path.join(tmpdir(), 'rehearsal-ledger');
  validateArtifacts({ outputRoot: temporary, canonicalRoot: temporary });
  assert.deepEqual(calls, [{ command: 'node', args: ['scripts/validate-contract-deployments.mjs'], root: temporary }]);
  calls.length = 0;
  validateArtifacts({ outputRoot: CANONICAL_DEPLOYMENTS_ROOT, canonicalRoot: CANONICAL_DEPLOYMENTS_ROOT });
  assert.deepEqual(calls.map((entry) => entry.args[0]), [
    'scripts/generate-contract-chain-config.mjs', 'scripts/validate-contract-deployments.mjs',
  ]);
});

for (const mode of ['dry-run', 'broadcast']) {
  test(`${mode} does not resolve or execute rehearsal prerequisites`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-non-rehearsal-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeJsonAtomic(path.join(directory, 'base-mainnet', 'current.json'), { release: 'active' });
    const current = {
      ...rehearsalMigration('M002', ['MISSING']),
      expectedState: (canonical) => canonical,
      observe: async () => ({ state: 'active' }),
      phases: [],
      printStatus() {},
      idleMessage: () => 'already active',
    };
    current.rehearsal.run = () => assert.fail('must not rehearse during ordinary deployment');
    const result = await runMigration(current, { ...REHEARSAL_OPTIONS, mode }, {
      canonicalRoot: directory, outputRoot: directory, rpcUrl: 'http://unused',
    });
    assert.equal(result.state, 'active');
  });
}

function observation(overrides = {}) {
  return {
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      legacyEmissions: ADDRESS.legacyEmissions,
      legacyStaking: ADDRESS.legacyStaking,
    },
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.legacyEmissions,
      staking: ADDRESS.legacyStaking,
    },
    antsRegistry: ADDRESS.registry,
    legacyEmissionsRegistry: ADDRESS.registry,
    channelsPaused: false,
    currentEpoch: 10,
    deployment: null,
    ...overrides,
  };
}

function deployed(overrides = {}) {
  return {
    valid: true,
    usageAccounting: ADDRESS.usageAccounting,
    sellerRegistry: ADDRESS.sellerRegistry,
    effectiveEpoch: 11,
    ...overrides,
  };
}

test('parses the explicit deployment modes', () => {
  assert.deepEqual(parseDeployArgs(['M001', '--network', 'base-sepolia', '--dry-run']), {
    migration: 'M001',
    network: 'base-sepolia',
    mode: 'dry-run',
    signers: {},
  });
  assert.deepEqual(
    parseDeployArgs(['M001', '--network', 'base-sepolia', '--broadcast', '--signer', 'deployer=account:deployer']).signers,
    { deployer: 'account:deployer' },
  );
  assert.equal(parseDeployArgs(['m001', '--network', 'base-sepolia', '--broadcast']).mode, 'broadcast');
  assert.equal(parseDeployArgs(['--', 'M001', '--network', 'base-sepolia', '--broadcast']).mode, 'broadcast');
  assert.equal(parseDeployArgs(['M001', '--network', 'base-mainnet', '--fork-test']).mode, 'fork-test');
});

test('parses M001 sandbox options without starting Anvil', () => {
  const parsed = parseSandboxArgs(['up', '--port', '18545', '--out', 'tmp/sandbox']);
  assert.equal(parsed.command, 'up');
  assert.equal(parsed.port, 18545);
  assert.equal(parsed.out.endsWith(path.join('tmp', 'sandbox')), true);
});

test('renders recognized-usage deployment fields into chain config', () => {
  const rendered = renderNetwork({ chainId: 8453, contracts: {
    registry: { address: ADDRESS.registry },
    legacyStaking: { address: ADDRESS.legacyStaking },
    legacyEmissionsV1: { address: ADDRESS.legacyEmissions },
    usageAccounting: { address: ADDRESS.usageAccounting },
    sellerRegistry: { address: ADDRESS.sellerRegistry },
  } });
  assert.equal(rendered.registryContractAddress, ADDRESS.registry);
  assert.equal(rendered.legacyStakingContractAddress, ADDRESS.legacyStaking);
  assert.equal(rendered.legacyEmissionsV1ContractAddress, ADDRESS.legacyEmissions);
  assert.equal(rendered.usageAccountingAddress, ADDRESS.usageAccounting);
  assert.equal(rendered.sellerRegistryAddress, ADDRESS.sellerRegistry);
});

test('parses signer specs and resolves them to addresses, never keys', async () => {
  assert.deepEqual(parseSignerSpecs(['a=ledger', 'b=keystore:/k/b']), { a: 'ledger', b: 'keystore:/k/b' });
  assert.throws(() => parseSignerSpecs(['a=ledger', 'a=ledger:1']), /given twice/);
  assert.throws(() => parseSignerSpecs(['nonsense']), /<role>=<spec>/);

  await assert.rejects(resolveSigners({}, ['deployer']), /--signer deployer=<spec>/);
  await assert.rejects(resolveSigners({ x: 'vault:abc' }, ['x']), /Unknown signer spec/);
  await assert.rejects(
    resolveSigners({ a: 'ledger:0', b: 'ledger:1' }, ['a', 'b'], { rpcUrl: 'http://x' }),
    /one --ledger per run/,
  );

  const keystoreDirectory = await mkdtemp(path.join(tmpdir(), 'antseed-keystore-'));
  try {
    const file = path.join(keystoreDirectory, 'owner.json');
    await writeJsonAtomic(file, { address: '0000000000000000000000000000000000000001', crypto: {} });
    const { signers, forgeArgs } = await resolveSigners(
      { registryOwner: `keystore:${file}`, channelsOwner: `keystore:${file}`, staker: `unlocked:${ADDRESS.ants}` },
      ['registryOwner', 'channelsOwner', 'staker'],
      { rpcUrl: 'http://x' },
    );
    assert.equal(signers.registryOwner.address, ADDRESS.registry);
    assert.equal(signers.staker.address, ADDRESS.ants);
    assert.deepEqual(forgeArgs, ['--keystore', file, '--unlocked'], 'one wallet flag per distinct wallet');
    assert.deepEqual(signers.channelsOwner.castArgs, ['--keystore', file]);
    assert.equal(JSON.stringify(signers).includes('crypto'), false, 'keystore contents never leave the resolver');
  } finally {
    await rm(keystoreDirectory, { recursive: true, force: true });
  }
});

test('rejects missing and conflicting modes', () => {
  assert.throws(() => parseDeployArgs(['M001', '--network', 'base-mainnet']), /Choose exactly one/);
  assert.throws(
    () => parseDeployArgs(['M001', '--network', 'base-sepolia', '--dry-run', '--broadcast']),
    /Choose exactly one/,
  );
  assert.throws(
    () => parseDeployArgs(['M009', '--network', 'base-mainnet', '--dry-run']),
    /Unknown deployment migration M009; available: M001, M002/,
  );
});

test('allows Base Sepolia submissions and Base mainnet production or fork runs', () => {
  assert.doesNotThrow(() => validateM001Options({ network: 'base-sepolia', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-sepolia', mode: 'broadcast' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'broadcast' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'fork-test' }));
  assert.throws(
    () => validateM001Options({ network: 'base-sepolia', mode: 'fork-test' }),
    /Base Sepolia.*Base mainnet.*fork-test/,
  );
});

test('uses the existing scheduler for pre-boundary broadcasts', () => {
  assert.equal(shouldRunM001Cutover('awaiting-epoch', 'broadcast'), true);
  assert.equal(shouldRunM001Cutover('cutover-ready', 'broadcast'), true);
  assert.equal(shouldRunM001Cutover('cutover-incomplete', 'broadcast'), true);
});

test('lets the cutover be reviewed before the epoch boundary', () => {
  // The cutover plan is the reviewed artifact for the most dangerous phase, so
  // a simulation must be able to produce it while the boundary is still ahead.
  assert.equal(shouldRunM001Cutover('awaiting-epoch', 'dry-run'), true);
  assert.equal(shouldRunM001Cutover('ready', 'dry-run'), false);
  assert.equal(shouldRunM001Cutover('active', 'dry-run'), false);
});

test('reports incomplete network baselines before deployment', () => {
  assert.doesNotThrow(() => validateM001Baseline({
    network: 'base-sepolia',
    contracts: {
      registry: { address: ADDRESS.registry },
      antsToken: { address: ADDRESS.ants },
      channels: { address: ADDRESS.channels },
      emissions: { address: ADDRESS.legacyEmissions },
      staking: { address: ADDRESS.legacyStaking },
    },
  }));
  assert.throws(
    () => validateM001Baseline({
      network: 'base-sepolia',
      contracts: {
        channels: { address: ADDRESS.channels },
        emissions: { address: ADDRESS.legacyEmissions },
        staking: { address: ADDRESS.legacyStaking },
      },
    }),
    /base-sepolia deployment baseline is missing: registry, antsToken/,
  );
});

test('registers migrations explicitly', () => {
  assert.equal(getDeploymentMigration('M001').id, 'M001');
  assert.deepEqual([...deploymentMigrations.keys()], ['M001', 'M002']);
  assert.equal(getDeploymentMigration('M002').id, 'M002');
});

test('rejects invalid and duplicate migration registrations', () => {
  const declared = (id) => ({ id, run() {}, phases: [{ id: 'deploy', guard() {}, run() {} }], releases: [`${id}-x`] });
  assert.throws(() => buildMigrationRegistry([declared('001')]), /Invalid deployment migration ID/);
  assert.throws(
    () => buildMigrationRegistry([declared('M001'), declared('M001')]),
    /Duplicate deployment migration/,
  );
});

test('writes mutable artifacts atomically and history records once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-deployment-artifacts-'));
  try {
    const currentFile = path.join(directory, 'current.json');
    const historyFile = path.join(directory, 'history', '001-example.json');
    await writeJsonAtomic(currentFile, { release: '000-baseline' });
    await writeJsonAtomic(currentFile, { release: '001-example' });
    assert.deepEqual(JSON.parse(await readFile(currentFile, 'utf8')), { release: '001-example' });

    await writeJsonOnce(historyFile, { release: '001-example' });
    await writeJsonOnce(historyFile, { release: '001-example' });
    await assert.rejects(
      writeJsonOnce(historyFile, { release: '001-rewritten' }),
      /Refusing to overwrite append-only deployment record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconciles history and current.json independently after an interrupted run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-deployment-reconcile-'));
  try {
    const context = { outputRoot: directory, network: 'base-sepolia' };
    const release = '001-recognized-usage-activated';

    // Nothing written yet: recovery must run.
    assert.equal(await historyRecordExists(context, release), false);
    assert.equal(await currentRelease(context), null);

    // A crash between the two writes leaves history present but current stale.
    await writeJsonOnce(
      path.join(directory, 'base-sepolia', 'history', `${release}.json`),
      { release },
    );
    await writeJsonAtomic(
      path.join(directory, 'base-sepolia', 'current.json'),
      { release: '001-recognized-usage-deployed' },
    );
    assert.equal(await historyRecordExists(context, release), true);
    assert.notEqual(
      await currentRelease(context),
      release,
      'history alone must not imply current.json advanced',
    );

    // Once the pointer catches up, both checks agree and recovery is a no-op.
    await writeJsonAtomic(path.join(directory, 'base-sepolia', 'current.json'), { release });
    assert.equal(await currentRelease(context), release);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('updates canonical contract aliases when a migration activates', () => {
  const current = {
    contracts: {
      emissions: { address: ADDRESS.legacyEmissions, deployedInRelease: null },
      staking: { address: ADDRESS.legacyStaking, deployedInRelease: null },
    },
  };
  const activeContracts = {
    usageAccounting: { address: ADDRESS.usageAccounting, deployedInRelease: true },
    sellerRegistry: { address: ADDRESS.sellerRegistry, deployedInRelease: true },
  };

  applyContractAliases(current, activeContracts, { emissions: 'usageAccounting', staking: 'sellerRegistry' });

  assert.equal(current.contracts.emissions.address, ADDRESS.usageAccounting);
  assert.equal(current.contracts.staking.address, ADDRESS.sellerRegistry);
  assert.notEqual(current.contracts.emissions, current.contracts.usageAccounting);
  assert.equal(current.contracts.emissions.deployedInRelease, true);
  assert.deepEqual(current.registryBefore, {
    emissions: ADDRESS.legacyEmissions,
    staking: ADDRESS.legacyStaking,
  });
  applyContractAliases(current, structuredClone(activeContracts), { emissions: 'usageAccounting', staking: 'sellerRegistry' });
  assert.equal(current.registryBefore.emissions, ADDRESS.legacyEmissions);
  assert.equal(current.registryBefore.staking, ADDRESS.legacyStaking);
});

for (const broadcast of [true, false]) {
  test(`Foundry ${broadcast ? 'broadcasts are sequential' : 'simulations do not enable broadcasting'}`, (t) => {
    const calls = [];
    t.mock.method(childProcess, 'spawnSync', (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    for (const verify of [true, false]) {
      runForgeScript({
        target: 'script/Example.s.sol:Example',
        rpcUrl: 'http://unused',
        broadcast,
        verify,
        etherscanApiKey: 'test-key',
        walletArgs: ['--account', 'operator'],
        env: {},
      });
      assert.deepEqual(calls.at(-1), {
        command: 'forge',
        args: [
          'script', 'script/Example.s.sol:Example', '--rpc-url', 'http://unused', '--via-ir',
          '--account', 'operator',
          ...(broadcast ? ['--broadcast', '--slow'] : []),
          ...(broadcast && verify
            ? ['--verify', '--etherscan-api-key', 'test-key', '--etherscan-api-version', 'v2']
            : []),
        ],
      });
    }
  });
}

function mockCast(t, reply) {
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'cast', 'no deployment commands may run');
    return { status: 0, stdout: reply(args), stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

for (const creationType of ['CREATE', 'CREATE2', null]) {
  test(`preserves creation provenance with ${creationType ?? 'CALL-only'} broadcasts`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-broadcast-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const codeHash = `0x${'ab'.repeat(32)}`;
    mockCast(t, (args) => {
      if (args[0] === 'codehash') return codeHash;
      assert.deepEqual(args.slice(0, 3), ['call', ADDRESS.sellerRegistry, 'owner()(address)']);
      return ADDRESS.registry;
    });
    const creation = {
      hash: `0x${'11'.repeat(32)}`,
      transactionType: creationType,
      contractName: 'AntseedSellerPools',
      contractAddress: ADDRESS.sellerRegistry,
      arguments: [ADDRESS.ants, ADDRESS.registry],
    };
    const configuration = {
      ...creation,
      hash: `0x${'22'.repeat(32)}`,
      transactionType: 'CALL',
      function: 'setRewardStaker(address,bool)',
      arguments: [ADDRESS.channels, true],
    };
    const transactions = creationType ? [creation, configuration] : [configuration];
    const file = path.join(directory, 'run-latest.json');
    await writeJsonAtomic(file, {
      transactions,
      receipts: transactions.map((transaction, index) => ({
        transactionHash: transaction.hash,
        status: '0x1',
        blockNumber: `0x${(100 + index).toString(16)}`,
        from: ADDRESS.registry,
        to: transaction.transactionType === 'CALL' ? ADDRESS.sellerRegistry : null,
      })),
    });
    const parsed = await parseBroadcast(file, 'http://unused', { AntseedSellerPools: 'sellerPools' });
    assert.equal(parsed.transactions.length, transactions.length);
    assert.equal(parsed.transactions.at(-1).action, configuration.function);
    if (!creationType) {
      assert.deepEqual(parsed.contracts, {});
      return;
    }
    assert.equal(parsed.transactions[0].action, 'deploy AntseedSellerPools');
    assert.deepEqual(parsed.contracts.sellerPools, {
      address: ADDRESS.sellerRegistry,
      deploymentBlock: 100,
      transactionHash: creation.hash,
      runtimeCodeHash: codeHash,
      version: '1',
      external: false,
      deployedInRelease: true,
      constructorArguments: creation.arguments,
      owner: ADDRESS.registry,
    });
  });
}

for (const [cached, registryState] of [
  [true, 'valid'], [false, 'valid'], [true, 'missing'], [true, 'mismatched'],
  [true, 'missing-policy'], [true, 'wrong-policy'],
]) {
  test(`checks activation ${cached ? 'with' : 'without'} a local checkpoint and ${registryState} wash registry`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-activated-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const emissionsGate = '0x0000000000000000000000000000000000000008';
    const pointsPolicyRegistry = '0x0000000000000000000000000000000000000009';
    const washTradingRegistry = '0x0000000000000000000000000000000000000010';
    const washTradingPointsPolicy = '0x0000000000000000000000000000000000000012';
    const contracts = Object.fromEntries(Object.entries({
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      emissionsGate,
      pointsPolicyRegistry,
      washTradingRegistry,
      washTradingPointsPolicy,
      positionInit: '0x0000000000000000000000000000000000000011',
    }).map(([key, address]) => [key, { address }]));
    const checkpoint = {
      chainId: 8453,
      effectiveEpoch: 11,
      cutoverTimestamp: 2100,
      contracts,
      verificationConfiguration: {
        washTradingRegistry,
        washTradingPointsPolicy,
        verificationMinterController: ADDRESS.channels,
        emissionsGateOwner: ADDRESS.registry,
        pointsPolicyRegistryOwner: ADDRESS.registry,
      },
    };
    const current = {
      network: 'base-mainnet',
      chainId: 8453,
      release: migration.releases[1],
      contracts: Object.fromEntries(Object.entries({
        registry: ADDRESS.registry,
        antsToken: ADDRESS.ants,
        channels: ADDRESS.channels,
        emissions: ADDRESS.legacyEmissions,
        staking: ADDRESS.legacyStaking,
      }).map(([key, address]) => [key, { address }])),
    };
    applyContractAliases(current, contracts, { emissions: 'usageAccounting', staking: 'sellerRegistry' });
    const currentPath = path.join(directory, current.network, 'current.json');
    const checkpointFile = path.join(directory, '.deployments', 'checkpoint.json');
    await writeJsonAtomic(currentPath, current);
    await writeJsonAtomic(path.join(directory, current.network, 'history', `${migration.releases[0]}.json`), checkpoint);
    await writeJsonAtomic(path.join(directory, current.network, 'history', `${migration.releases[1]}.json`), { release: current.release });
    if (cached) await writeJsonAtomic(checkpointFile, checkpoint);
    mockCast(t, (args) => {
      if (args[0] === 'chain-id') return '8453';
      if (args[0] === 'code') {
        const missing = registryState === 'missing' && args[1] === washTradingRegistry
          || registryState === 'missing-policy' && args[1] === washTradingPointsPolicy;
        return missing ? '0x' : '0x1234';
      }
      assert.equal(args[0], 'call', 'restart must only read chain state');
      const [, address, signature] = args;
      if (signature === 'registry()(address)') {
        assert.ok([ADDRESS.ants, ADDRESS.legacyEmissions].includes(address), 'never call the legacy ABI on the new usage accounting contract');
        return emissionsGate;
      }
      const replies = {
        'antsToken()(address)': ADDRESS.ants,
        'channels()(address)': ADDRESS.channels,
        'emissions()(address)': ADDRESS.usageAccounting,
        'staking()(address)': ADDRESS.sellerRegistry,
        'paused()(bool)': 'false',
        'currentEpoch()(uint256)': '12',
        'emissionsGate()(address)': emissionsGate,
        'pointsPolicy()(address)': pointsPolicyRegistry,
        'washTradingRegistry()(address)': registryState === 'mismatched' ? ADDRESS.channels : washTradingRegistry,
        'minters(bytes32)(address,uint32,bool)': JSON.stringify([ADDRESS.channels, 10000, true]),
        'policyCount()(uint256)': '1',
        'policyAt(uint256)(address)': registryState === 'wrong-policy' ? ADDRESS.channels : washTradingPointsPolicy,
        'owner()(address)': ADDRESS.registry,
        'genesis()(uint256)': '1000',
        'epochDuration()(uint256)': '100',
      };
      assert.ok(Object.hasOwn(replies, signature), `unexpected call: ${signature}`);
      return replies[signature];
    });
    const canonical = JSON.parse(await readFile(currentPath, 'utf8'));
    const context = {
      canonical,
      expected: migration.expectedState(canonical),
      network: canonical.network,
      outputRoot: directory,
      checkpointFile,
      rpcUrl: 'http://unused',
    };
    if (registryState !== 'valid') {
      const result = await migration.observe(context);
      assert.equal(result.state, 'invalid');
      assert.equal(result.deployment.valid, false);
      return;
    }
    const result = await executePhases(migration, { mode: 'broadcast', signers: {} }, {}, context);
    assert.equal(result.state, 'active');
    assert.equal(context.expected.legacyEmissions, ADDRESS.legacyEmissions);
    assert.equal(context.expected.legacyStaking, ADDRESS.legacyStaking);
    assert.equal(migration.idleMessage(result), 'M001 is already active; no transactions required.');
    assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), current);
  });
}

test('classifies the complete M001 lifecycle', () => {
  assert.equal(classifyM001(observation()), 'ready');
  assert.equal(classifyM001(observation({ deployment: deployed() })), 'awaiting-epoch');
  assert.equal(classifyM001(observation({ deployment: deployed(), currentEpoch: 11 })), 'cutover-ready');
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    currentEpoch: 11,
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.legacyStaking,
    },
  })), 'cutover-incomplete');
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    currentEpoch: 11,
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.sellerRegistry,
    },
  })), 'active');
});

test('rejects unknown pointers and missing deployment checkpoints', () => {
  assert.equal(classifyM001(observation({
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.legacyStaking,
    },
  })), 'invalid');
  assert.equal(classifyM001(observation({ deployment: deployed({ valid: false }) })), 'invalid');
});

test('treats a paused deployed migration as an incomplete cutover', () => {
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    channelsPaused: true,
    currentEpoch: 11,
  })), 'cutover-incomplete');
});

test('requires migrations to declare phases and releases', () => {
  const base = { id: 'M002', run() {}, phases: [{ id: 'deploy', guard() {}, run() {} }], releases: ['002-x'] };
  assert.doesNotThrow(() => buildMigrationRegistry([base]));
  assert.throws(() => buildMigrationRegistry([{ ...base, phases: [] }]), /at least one phase/);
  assert.throws(
    () => buildMigrationRegistry([{ ...base, phases: [{ id: 'deploy' }] }]),
    /require an id, a guard, and a run function/,
  );
  assert.throws(() => buildMigrationRegistry([{ ...base, releases: [] }]), /must declare the releases it writes/);
});

test('signer helpers map declared roles and enforce every owner requirement', (testContext) => {
  const names = { deployer: 'DEPLOYER', admin: 'ADMIN' };
  const environment = signerEnvironment(names, { deployer: ADDRESS.registry, ignored: ADDRESS.channels });
  assert.deepEqual(environment, { DEPLOYER: ADDRESS.registry });
  const calls = [];
  mockCast(testContext, (args) => { calls.push(args); return ADDRESS.registry; });
  const requirements = [['deployer', ADDRESS.ants, 'token'], ['deployer', ADDRESS.channels, 'channels']];
  assert.doesNotThrow(() => assertSignerOwners('http://unused', environment, names, requirements));
  assert.equal(calls.length, 2);
  assert.throws(() => assertSignerOwners('http://unused', {}, names, requirements), /DEPLOYER/);
  assert.throws(() => assertSignerOwners('http://unused', { DEPLOYER: ADDRESS.channels }, names, requirements), /not the token owner/);
});

test('release helpers preserve explicit metadata, transaction order, and creation provenance', () => {
  const context = { network: 'base-sepolia', canonical: { chainId: 84532 } };
  const fields = { release: '002-example', status: 'deployed', sourceCommit: 'reviewed-commit', effectiveEpoch: 11 };
  assert.deepEqual(buildReleaseRecord(context, fields), {
    ...fields, $schema: '../../schema.json', network: 'base-sepolia', chainId: 84532,
  });
  const previous = { transactions: [{ hash: '0xAB', action: 'old' }, { hash: '0xcd' }], contracts: { first: { address: ADDRESS.ants } } };
  const parsed = { transactions: [{ hash: '0xab', action: 'confirmed' }, { hash: '0xef' }], contracts: { second: { address: ADDRESS.channels } } };
  const merged = mergeBroadcast(previous, parsed);
  assert.deepEqual(merged.transactions, [parsed.transactions[0], previous.transactions[1], parsed.transactions[1]]);
  assert.deepEqual(merged.contracts, { ...previous.contracts, ...parsed.contracts });
  assert.deepEqual(mergeBroadcast(merged, parsed), merged);
  assert.equal(previous.transactions[0].action, 'old');
});

test('activation record writes never overwrite existing history while repairing current', async (testContext) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-activation-records-'));
  testContext.after(() => rm(directory, { recursive: true, force: true }));
  const context = { outputRoot: directory, network: 'test' };
  const record = { release: '002-example', sourceCommit: 'reviewed-commit' };
  const history = path.join(directory, 'test/history/002-example.json');
  await writeJsonAtomic(history, record);
  const original = await readFile(history, 'utf8');
  await writeActivationRecords(context, { ...record, sourceCommit: 'different-commit' }, record);
  assert.equal(await readFile(history, 'utf8'), original);
  assert.equal(await currentRelease(context), record.release);
});

let fixtureChainId = 990000;

async function m001Fixture(testContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-readable-m001-'));
  const network = 'base-sepolia';
  const chainId = ++fixtureChainId;
  const contracts = {
    AntseedUsageAccounting: ADDRESS.usageAccounting,
    AntseedSellerRegistry: ADDRESS.sellerRegistry,
    AntseedEmissionsGate: '0x0000000000000000000000000000000000000008',
    AntseedPointsPolicyRegistry: '0x0000000000000000000000000000000000000009',
    AntseedLegacyEmissionsEscrow: '0x000000000000000000000000000000000000000a',
    AntseedPositionInit: '0x000000000000000000000000000000000000000b',
    AntseedWashTradingRegistry: '0x000000000000000000000000000000000000000c',
    AntseedWashTradingPointsPolicy: '0x000000000000000000000000000000000000000d',
  };
  const canonical = {
    network, chainId, release: '000-baseline', status: 'active', $schema: '../schema.json',
    contracts: Object.fromEntries(Object.entries({
      registry: ADDRESS.registry, antsToken: ADDRESS.ants, channels: ADDRESS.channels,
      emissions: ADDRESS.legacyEmissions, staking: ADDRESS.legacyStaking,
    }).map(([name, address]) => [name, { address }])),
  };
  const context = {
    migrationId: 'M001', network, canonical, expected: migration.expectedState(canonical),
    outputRoot: directory, checkpointFile: path.join(directory, 'checkpoint.json'),
    receiptDirectory: path.join(directory, 'receipts'), rpcUrl: 'http://unused', forkTest: true,
  };
  const paths = {
    deploy: broadcastPath('Deploy.s.sol', chainId), cutover: broadcastPath('Cutover.s.sol', chainId),
    deployed: path.join(directory, network, 'history/001-recognized-usage-deployed.json'),
    activated: path.join(directory, network, 'history/001-recognized-usage-activated.json'),
    current: path.join(directory, network, 'current.json'),
  };
  const deployment = {
    transactions: Object.entries(contracts).map(([contractName, contractAddress], index) => ({
      hash: `0x${String(index + 1).padStart(64, '0')}`, transactionType: 'CREATE', contractName, contractAddress, arguments: [],
    })),
  };
  const activation = {
    transactions: [{ hash: `0x${'ab'.repeat(32)}`, transactionType: 'CALL', function: 'setEmissions(address)' }],
  };
  for (const [file, broadcast] of [[paths.deploy, deployment], [paths.cutover, activation]]) {
    broadcast.receipts = broadcast.transactions.map(({ hash }) => ({
      transactionHash: hash, status: '0x1', blockNumber: '0x10', from: ADDRESS.registry, to: ADDRESS.registry,
    }));
    await writeJsonAtomic(file, broadcast);
  }
  const state = { deployed: false, active: false, paused: false, failForge: false, badBytecode: false, policyCount: 1, receiptsLive: true };
  const calls = [];
  const owners = {};
  const artifactRoot = path.join(CONTRACTS_ROOT, 'out');
  const originalReadFile = fsPromises.readFile;
  const originalReaddir = fsPromises.readdir;
  const artifactFiles = new Set(Object.keys(contracts).map(name => path.join(artifactRoot, `${name}.sol`, `${name}.json`)));
  testContext.mock.method(fsPromises, 'readdir', (target, options) => {
    if (target === artifactRoot) return Promise.resolve(Object.keys(contracts).map(name => ({ name: `${name}.sol`, isDirectory: () => true })));
    const name = path.basename(target, '.sol');
    if (Object.hasOwn(contracts, name) && path.dirname(target) === artifactRoot) return Promise.resolve([`${name}.json`]);
    return originalReaddir(target, options);
  });
  testContext.mock.method(fsPromises, 'readFile', (target, options) => artifactFiles.has(target)
    ? Promise.resolve(JSON.stringify({ deployedBytecode: { object: '0x6000', immutableReferences: {} } }))
    : originalReadFile(target, options));
  testContext.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, options });
    const result = stdout => ({ status: 0, stdout, stderr: '' });
    if (command === 'git') {
      assert.deepEqual(args, ['rev-parse', 'HEAD']);
      return result('a'.repeat(40));
    }
    if (command === 'forge') {
      if (state.failForge) return { status: 1, stdout: '', stderr: '' };
      if (args.includes('--broadcast')) {
        if (args[1].includes('/Deploy.s.sol:')) state.deployed = true;
        else state.active = true;
      }
      return result('');
    }
    assert.equal(command, 'cast', 'must never execute a real deployment');
    const [operation, address, signature] = args;
    if (operation === 'codehash') return result(`0x${'ab'.repeat(32)}`);
    if (operation === 'chain-id') return result(String(chainId));
    if (operation === 'code') return result(state.badBytecode ? '0x6001' : '0x6000');
    if (operation === 'receipt') return result(JSON.stringify({ status: state.receiptsLive ? '0x1' : '0x0' }));
    if (operation === 'send') {
      state.paused = signature === 'pause()';
      return result(JSON.stringify({
        transactionHash: state.paused ? '0x00' : '0xff', blockNumber: '0x11', from: ADDRESS.registry, to: ADDRESS.channels,
      }));
    }
    assert.equal(operation, 'call');
    if (signature === 'owner()(address)') return result(owners[address] ?? ADDRESS.registry);
    if (signature === 'registry()(address)') return result(!state.deployed ? ADDRESS.registry
      : address === ADDRESS.ants ? contracts.AntseedEmissionsGate : contracts.AntseedLegacyEmissionsEscrow);
    const replies = {
      'antsToken()(address)': ADDRESS.ants, 'channels()(address)': ADDRESS.channels,
      'emissions()(address)': state.active ? ADDRESS.usageAccounting : ADDRESS.legacyEmissions,
      'staking()(address)': state.active ? ADDRESS.sellerRegistry : ADDRESS.legacyStaking,
      'emissionsGate()(address)': contracts.AntseedEmissionsGate,
      'pointsPolicy()(address)': contracts.AntseedPointsPolicyRegistry,
      'washTradingRegistry()(address)': contracts.AntseedWashTradingRegistry,
      'sellerRewardsPool()(address)': ADDRESS.sellerRewardsPool,
      'paused()(bool)': String(state.paused), 'currentEpoch()(uint256)': '11',
      'effectiveEpoch()(uint256)': '11', 'genesis()(uint256)': '1000', 'epochDuration()(uint256)': '100',
      'policyCount()(uint256)': String(state.policyCount),
      'policyAt(uint256)(address)': contracts.AntseedWashTradingPointsPolicy,
      'minters(bytes32)(address,uint32,bool)': JSON.stringify([ADDRESS.registry, 10000, true]),
      'staked(address)(uint256)': '1',
    };
    assert.ok(Object.hasOwn(replies, signature), `unexpected call: ${signature}`);
    return result(replies[signature]);
  });
  syncBuiltinESMExports();
  testContext.after(async () => {
    testContext.mock.restoreAll();
    syncBuiltinESMExports();
    await Promise.all([directory, path.dirname(paths.deploy), path.dirname(paths.cutover)]
      .map(target => rm(target, { recursive: true, force: true })));
  });
  const environment = { BASESCAN_API_KEY: 'test', CHANNELS_OWNER: ADDRESS.registry };
  const wallet = { forgeArgs: ['--account', 'registry-owner'], signers: { channelsOwner: { castArgs: ['--account', 'registry-owner'] } } };
  return {
    context, paths, deployment, activation, state, calls, owners, contracts, environment, wallet,
    deploy: mode => migration.phases[0].run(context, mode, environment, {}, wallet),
    cutover: async () => {
      const checkpoint = JSON.parse(await readFile(context.checkpointFile, 'utf8'));
      return migration.phases[1].run(context, 'broadcast', environment, { deployment: { checkpoint } }, wallet);
    },
  };
}

for (const mode of ['dry-run', 'broadcast']) {
  for (const failForge of [false, true]) {
    test(`M001 deploy ${mode} ${failForge ? 'failure' : 'success'} records only successful broadcasts`, async (testContext) => {
      const fixture = await m001Fixture(testContext);
      fixture.state.failForge = failForge;
      if (failForge) await assert.rejects(fixture.deploy(mode), /forge exited/);
      else await fixture.deploy(mode);
      const forge = fixture.calls.find(call => call.command === 'forge');
      assert.equal(forge.args.includes('--broadcast'), mode === 'broadcast');
      assert.equal(forge.args.includes('--slow'), mode === 'broadcast');
      assert.equal(forge.args.includes('--verify'), false);
      assert.ok(forge.args.includes('registry-owner'));
      if (mode === 'broadcast' && !failForge) {
        const record = JSON.parse(await readFile(fixture.paths.deployed, 'utf8'));
        const checkpoint = JSON.parse(await readFile(fixture.context.checkpointFile, 'utf8'));
        assert.equal(record.sourceCommit, 'a'.repeat(40));
        assert.equal(record.effectiveEpoch, 11);
        assert.equal(record.cutoverStarted, undefined);
        assert.equal(record.cutoverTimestamp, undefined);
        assert.equal(checkpoint.cutoverTimestamp, 2100);
        await rm(fixture.context.checkpointFile);
        const observed = await migration.observe(fixture.context);
        assert.deepEqual(observed.deployment.checkpoint, checkpoint);
      } else {
        await assert.rejects(readFile(fixture.context.checkpointFile), { code: 'ENOENT' });
        await assert.rejects(readFile(fixture.paths.deployed), { code: 'ENOENT' });
      }
    });
  }
}

test('M001 refuses deployment receipts missing required contracts', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  fixture.deployment.receipts = [];
  await writeJsonAtomic(fixture.paths.deploy, fixture.deployment);
  await assert.rejects(fixture.deploy('broadcast'), /all required M001 contracts/);
  await assert.rejects(readFile(fixture.context.checkpointFile), { code: 'ENOENT' });
});

for (const receiptsLive of [false, true]) {
  test(`M001 recovery ${receiptsLive ? 'rebuilds records from confirmed receipts' : 'refuses unconfirmed receipts'}`, async (testContext) => {
    const fixture = await m001Fixture(testContext);
    fixture.state.deployed = true;
    fixture.state.receiptsLive = receiptsLive;
    const observed = await migration.observe(fixture.context);
    assert.equal(observed.state, 'invalid');
    assert.equal(await migration.recover(fixture.context, observed), receiptsLive);
    if (receiptsLive) assert.equal((await migration.observe(fixture.context)).state, 'cutover-ready');
    else await assert.rejects(readFile(fixture.context.checkpointFile), { code: 'ENOENT' });
    assert.equal(fixture.calls.some(call => call.command === 'forge' || call.args[0] === 'send'), false);
  });
}

test('M001 uses one configuration snapshot for checkpoint validation', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  await fixture.deploy('broadcast');
  fixture.calls.length = 0;
  assert.equal((await migration.observe(fixture.context)).deployment.valid, true);
  for (const signature of [
    'minters(bytes32)(address,uint32,bool)', 'policyCount()(uint256)',
    'washTradingRegistry()(address)', 'policyAt(uint256)(address)',
  ]) {
    assert.equal(fixture.calls.filter(call => call.args.includes(signature)).length, 1);
  }
  fixture.state.policyCount = 0;
  assert.equal((await migration.observe(fixture.context)).state, 'invalid');
  fixture.state.policyCount = 1;
  fixture.owners[fixture.contracts.AntseedEmissionsGate] = ADDRESS.channels;
  assert.equal((await migration.observe(fixture.context)).state, 'invalid');
});

test('M001 signer discovery and validation share ownership targets without dropping either legacy owner', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  const environment = {
    VERIFICATION_WALLET: ADDRESS.registry, SP1_VERIFIER: ADDRESS.channels,
    SP1_VERIFIER_HASH: `0x${'1'.repeat(64)}`, WASH_TRADING_SELLER_PROGRAM_VKEY: `0x${'2'.repeat(64)}`,
    HISTORICAL_PERIOD_START_BLOCK: '1', HISTORICAL_PERIOD_END_BLOCK: '100',
    DEPLOYER: ADDRESS.registry, REGISTRY_OWNER: ADDRESS.registry, CHANNELS_OWNER: ADDRESS.registry,
    DIEM_STAKING_PROXY: ADDRESS.channels, DIEM_STAKER: ADDRESS.registry, SELLER_REWARDS_POOL_OWNER: ADDRESS.registry,
  };
  const ready = { state: 'ready' };
  assert.equal(migration.expectedSigner('deployer', fixture.context, ready), ADDRESS.registry);
  migration.verifyRoles(fixture.context, ready, environment);
  fixture.owners[ADDRESS.legacyEmissions] = ADDRESS.channels;
  assert.throws(() => migration.verifyRoles(fixture.context, ready, environment), /not the legacy emissions owner/);
  delete fixture.owners[ADDRESS.legacyEmissions];
  await fixture.deploy('broadcast');
  const deployed = await migration.observe(fixture.context);
  migration.verifyRoles(fixture.context, deployed, environment);
  for (const [role, contract, label] of [
    ['deployer', fixture.contracts.AntseedEmissionsGate, 'emissions gate'], ['registryOwner', ADDRESS.registry, 'Registry'],
    ['channelsOwner', ADDRESS.channels, 'Channels'], ['sellerRewardsPoolOwner', ADDRESS.sellerRewardsPool, 'seller rewards pool'],
  ]) {
    fixture.owners[contract] = ADDRESS.ants;
    assert.equal(migration.expectedSigner(role, fixture.context, deployed), ADDRESS.ants);
    assert.throws(() => migration.verifyRoles(fixture.context, deployed, environment),
      new RegExp(`${role} .*is not the ${label} owner`));
    delete fixture.owners[contract];
  }
  delete environment.DIEM_STAKING_PROXY;
  fixture.owners[ADDRESS.sellerRewardsPool] = ADDRESS.ants;
  migration.verifyRoles(fixture.context, deployed, environment);
  delete fixture.owners[ADDRESS.sellerRewardsPool];
  for (const [name, value, message] of [
    ['HISTORICAL_PERIOD_START_BLOCK', '0', /must be nonzero/],
    ['HISTORICAL_PERIOD_START_BLOCK', '101', /must not exceed/],
    ['HISTORICAL_PERIOD_END_BLOCK', '0x64', /decimal block number/],
    ['HISTORICAL_PERIOD_END_BLOCK', String(2n ** 64n), /exceeds uint64/],
  ]) {
    assert.throws(() => migration.verifyRoles(fixture.context, ready, { ...environment, [name]: value }), message);
  }
});

test('M001 environment keeps overrides and checkpoint addresses in their original precedence', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  const signerAddresses = { deployer: ADDRESS.registry };
  const extra = { DEPLOYER: ADDRESS.ants, ANTSEED_REGISTRY: ADDRESS.channels, DIEM_STAKING_PROXY: ADDRESS.ants };
  const ready = migration.environment(fixture.context, { state: 'ready' }, signerAddresses, extra);
  assert.equal(ready.DEPLOYER, extra.DEPLOYER);
  assert.equal(ready.ANTSEED_REGISTRY, extra.ANTSEED_REGISTRY);
  assert.equal(ready.DIEM_STAKING_PROXY, extra.DIEM_STAKING_PROXY);
  await fixture.deploy('broadcast');
  const observed = await migration.observe(fixture.context);
  const deployed = migration.environment(fixture.context, observed, signerAddresses, {
    USAGE_ACCOUNTING: ADDRESS.ants, SELLER_REGISTRY: ADDRESS.ants,
  });
  assert.equal(deployed.USAGE_ACCOUNTING, ADDRESS.usageAccounting);
  assert.equal(deployed.SELLER_REGISTRY, ADDRESS.sellerRegistry);
});

for (const fails of [false, true]) {
  test(`M001 ${fails ? 'failed' : 'successful'} cutover captures partial receipts and ${fails ? 'does not activate' : 'preserves transaction order'}`, async (testContext) => {
    const fixture = await m001Fixture(testContext);
    await fixture.deploy('broadcast');
    fixture.state.failForge = fails;
    if (fails) await assert.rejects(fixture.cutover(), /forge exited/);
    else await fixture.cutover();
    const checkpoint = JSON.parse(await readFile(fixture.context.checkpointFile, 'utf8'));
    assert.equal(checkpoint.cutoverTransactions.length, 1);
    if (fails) {
      assert.equal(fixture.state.paused, true);
      await assert.rejects(readFile(fixture.paths.activated), { code: 'ENOENT' });
      fixture.state.failForge = false;
      await fixture.cutover();
    }
    const record = JSON.parse(await readFile(fixture.paths.activated, 'utf8'));
    assert.deepEqual(record.transactions.map(({ hash }) => hash), ['0x00', fixture.activation.transactions[0].hash, '0xff']);
    const current = JSON.parse(await readFile(fixture.paths.current, 'utf8'));
    assert.equal(current.contracts.emissions.address, ADDRESS.usageAccounting);
    assert.equal(current.registryBefore.emissions, ADDRESS.legacyEmissions);
    assert.equal(fixture.state.paused, false);
  });
}

test('M001 receipt capture errors prevent activation records', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  await fixture.deploy('broadcast');
  await fsPromises.writeFile(fixture.paths.cutover, 'invalid JSON');
  await assert.rejects(fixture.cutover(), SyntaxError);
  await assert.rejects(readFile(fixture.paths.activated), { code: 'ENOENT' });
});

test('M001 requires confirmed cutover receipts before activation records', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  await fixture.deploy('broadcast');
  fixture.activation.receipts = [];
  await writeJsonAtomic(fixture.paths.cutover, fixture.activation);
  await assert.rejects(fixture.cutover(), /Confirmed Foundry cutover receipts/);
  await assert.rejects(readFile(fixture.paths.activated), { code: 'ENOENT' });
});

for (const missing of ['history', 'current', 'both']) {
  test(`M001 finalization repairs missing ${missing} independently and is then a no-op`, async (testContext) => {
    const fixture = await m001Fixture(testContext);
    await fixture.deploy('broadcast');
    await fixture.cutover();
    const history = await readFile(fixture.paths.activated, 'utf8');
    const current = await readFile(fixture.paths.current, 'utf8');
    if (missing !== 'current') await rm(fixture.paths.activated);
    if (missing !== 'history') await rm(fixture.paths.current);
    const checkpoint = JSON.parse(await readFile(fixture.context.checkpointFile, 'utf8'));
    const observation = { state: 'active', deployment: { checkpoint } };
    assert.equal(await migration.finalize(fixture.context, observation, 'dry-run'), false);
    assert.equal(await migration.finalize(fixture.context, { ...observation, state: 'cutover-incomplete' }, 'broadcast'), false);
    fixture.calls.length = 0;
    assert.equal(await migration.finalize(fixture.context, observation, 'broadcast'), true);
    assert.ok(fixture.calls.some(call => call.args[0] === 'code'));
    assert.equal(await readFile(fixture.paths.activated, 'utf8'), history);
    assert.equal(await readFile(fixture.paths.current, 'utf8'), current);
    fixture.calls.length = 0;
    assert.equal(await migration.finalize(fixture.context, observation, 'broadcast'), false);
    assert.deepEqual(fixture.calls, []);
  });
}

test('M001 finalization verifies bytecode before writing anything', async (testContext) => {
  const fixture = await m001Fixture(testContext);
  await fixture.deploy('broadcast');
  const checkpoint = JSON.parse(await readFile(fixture.context.checkpointFile, 'utf8'));
  fixture.state.badBytecode = true;
  await assert.rejects(migration.finalize(fixture.context, { state: 'active', deployment: { checkpoint } }, 'broadcast'), /local build does not match/);
  await assert.rejects(readFile(fixture.paths.activated), { code: 'ENOENT' });
  await assert.rejects(readFile(fixture.paths.current), { code: 'ENOENT' });
  assert.equal(JSON.parse(await readFile(fixture.context.checkpointFile, 'utf8')).cutoverTransactions, undefined);
});

test('maps every declared release to exactly one owning migration', () => {
  const owners = buildReleaseOwners(deploymentMigrations);
  assert.equal(owners.get('001-recognized-usage-deployed').id, 'M001');
  assert.equal(owners.get('001-recognized-usage-activated').id, 'M001');

  const registry = buildMigrationRegistry([
    { id: 'M002', run() {}, phases: [{ id: 'a', guard() {}, run() {} }], releases: ['shared'] },
    { id: 'M003', run() {}, phases: [{ id: 'a', guard() {}, run() {} }], releases: ['shared'] },
  ]);
  assert.throws(() => buildReleaseOwners(registry), /claimed by M002 and M003/);
});

test('selects the deploy phase before deployment and the cutover phase after it', () => {
  const [deployPhase, cutoverPhase] = migration.phases;
  assert.equal(deployPhase.id, 'deploy');
  assert.equal(cutoverPhase.id, 'cutover');

  assert.equal(deployPhase.guard({ state: 'ready' }, 'broadcast'), true);
  assert.equal(deployPhase.guard({ state: 'cutover-ready' }, 'broadcast'), false);

  assert.equal(cutoverPhase.guard({ state: 'cutover-ready' }, 'dry-run'), true);
  assert.equal(cutoverPhase.guard({ state: 'awaiting-epoch' }, 'broadcast'), true);
  // A simulation selects the cutover before the boundary so its plan is reviewable.
  assert.equal(cutoverPhase.guard({ state: 'awaiting-epoch' }, 'dry-run'), true);
  assert.equal(cutoverPhase.guard({ state: 'active' }, 'broadcast'), false);
});

test('passes phase run results into async plans and preserves transaction order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-runner-plan-'));
  const simulationFile = path.join(directory, 'simulation.json');
  await writeJsonAtomic(simulationFile, {
    transactions: [{
      transactionType: 'CALL',
      function: 'performChange()',
      transaction: { to: ADDRESS.registry, from: ADDRESS.ants, value: '0x0', input: '0x1234' },
    }],
  });
  const context = {
    migrationId: 'M999',
    network: 'test-network',
    outputRoot: directory,
    canonical: { chainId: 999 },
    rpcUrl: 'http://127.0.0.1:1',
  };
  let planSawRunResult = false;
  const migrationUnderTest = {
    id: 'M999',
    phases: [{
      id: 'change',
      guard: () => true,
      signers: () => ['actor'],
      async run(_context, _mode, environment, _observation, wallet) {
        assert.equal(environment.ACTOR, ADDRESS.ants, 'the runner passes signer ADDRESSES to the phase');
        assert.deepEqual(wallet.forgeArgs, ['--unlocked']);
        return { simulationFile, marker: 'phase-result' };
      },
      async plan(_context, _observation, runResult) {
        planSawRunResult = runResult.marker === 'phase-result';
        return {
          release: '999-test-release',
          phaseId: 'change',
          simulationFile: runResult.simulationFile,
          beforeTransactions: [{
            action: 'pause example',
            to: ADDRESS.channels,
            function: 'pause()',
            condition: 'when traffic must stop',
          }],
          afterTransactions: [{
            action: 'resume example',
            to: ADDRESS.channels,
            function: 'unpause()',
            condition: 'only after verification',
          }],
        };
      },
    }],
    observe: async () => ({ state: 'ready' }),
    printStatus() {},
    environment: (_context, _observation, signerAddresses) => ({ ACTOR: signerAddresses.actor }),
    verifyRoles() {},
    expectedSigner: () => ADDRESS.ants,
  };

  try {
    await executePhases(migrationUnderTest, { mode: 'dry-run' }, {}, context);
    const plan = JSON.parse(await readFile(
      path.join(directory, 'test-network', 'pending', '999-test-release.plan.json'),
      'utf8',
    ));
    assert.equal(planSawRunResult, true);
    assert.deepEqual(plan.transactions.map((transaction) => transaction.function), [
      'pause()',
      'performChange()',
      'unpause()',
    ]);
    assert.equal(plan.transactions[0].condition, 'when traffic must stop');
    assert.equal(plan.transactions[2].condition, 'only after verification');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('always terminates disposable Anvil forks after success or failure', async () => {
  const children = [];
  const advances = [];
  const dependencies = {
    availablePort: async () => 18545,
    spawn: (_command, args) => {
      const child = { args, killed: false, kill() { this.killed = true; } };
      children.push(child);
      return child;
    },
    waitForAnvil: async () => {},
    advanceTimeTo: (rpcUrl, timestamp) => advances.push({ rpcUrl, timestamp }),
  };

  const result = await withAnvilFork(
    { forkUrl: 'https://rpc.example', chainId: 999, timestamp: 1234 },
    async ({ rpcUrl }) => rpcUrl,
    dependencies,
  );
  assert.equal(result, 'http://127.0.0.1:18545');
  assert.equal(children[0].killed, true);
  assert.equal(children[0].args.includes('--fork-block-number'), false, 'latest block is used when none is pinned');
  assert.equal(children[0].args.includes('--no-rate-limit'), true);
  assert.equal(children[0].args.includes('--retries'), true);
  assert.equal(children[0].args.includes('--timeout'), true);
  assert.equal(children[0].args.includes('--disable-min-priority-fee'), true);
  assert.deepEqual(advances, [{ rpcUrl: result, timestamp: 1234 }]);

  await assert.rejects(
    withAnvilFork(
      { forkUrl: 'https://rpc.example', forkBlockNumber: 42, chainId: 999 },
      async () => { throw new Error('simulation failed'); },
      dependencies,
    ),
    /simulation failed/,
  );
  assert.equal(children[1].killed, true);
  assert.equal(children[1].args.includes('42'), true);

  await withAnvilFork(
    { forkUrl: 'https://rpc.example', chainId: 999, port: 19545, keepAlive: true },
    async ({ rpcUrl, child }) => {
      assert.equal(rpcUrl, 'http://127.0.0.1:19545');
      assert.equal(child, children[2]);
    },
    dependencies,
  );
  assert.equal(children[2].killed, false);
});

test('rebuilds a missing checkpoint from the committed history record', async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'antseed-checkpoint-'));
  const context = {
    outputRoot,
    network: 'base-sepolia',
    checkpointFile: path.join(outputRoot, '.deployments', 'm001-base-sepolia.json'),
  };
  const release = '001-recognized-usage-deployed';
  try {
    assert.equal(await readCheckpoint(context, release, () => { throw new Error('unreachable'); }), null);

    await writeJsonOnce(path.join(outputRoot, 'base-sepolia', 'history', `${release}.json`), { release, effectiveEpoch: 7 });
    const rebuilt = await readCheckpoint(context, release, (record) => ({ fromRecord: record.effectiveEpoch }));
    assert.deepEqual(rebuilt, { fromRecord: 7 });
    assert.deepEqual(JSON.parse(await readFile(context.checkpointFile, 'utf8')), rebuilt, 'the rebuilt checkpoint is cached');

    // Once cached, the local checkpoint wins and history is not consulted again.
    await writeJsonAtomic(context.checkpointFile, { fromRecord: 7, cutoverStarted: true });
    const cached = await readCheckpoint(context, release, () => { throw new Error('unreachable'); });
    assert.equal(cached.cutoverStarted, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('permits only the phase-one record to be dirty during a cutover broadcast', () => {
  assert.deepEqual(migration.allowedDirtyReleases({ state: 'ready' }), []);
  assert.deepEqual(migration.allowedDirtyReleases({ state: 'cutover-ready' }), ['001-recognized-usage-deployed']);
});

test('enforces M001 release invariants', () => {
  const contracts = {
    washTradingRegistry: { address: ADDRESS.registry },
    washTradingPointsPolicy: { address: ADDRESS.sellerRegistry },
    positionInit: { address: ADDRESS.channels },
  };
  const validate = (record) => migration.recordErrors({ contracts, ...record }).length === 0;
  const verificationConfiguration = {
    washTradingRegistry: ADDRESS.registry,
    washTradingPointsPolicy: ADDRESS.sellerRegistry,
    verificationMinterController: ADDRESS.registry,
    verificationMinterShareBps: 10_000,
    verificationMinterEditable: true,
    pointsPolicyCount: 1,
    emissionsGateOwner: ADDRESS.ants,
    pointsPolicyRegistryOwner: ADDRESS.channels,
  };

  assert.equal(validate({ verificationConfiguration }), true);
  assert.equal(validate({ verificationConfiguration, contracts: {} }), false, 'M001 must record its registry and faucet');
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, washTradingRegistry: ADDRESS.ants } }),
    false,
    'the points policy must pin the registry deployed by M001',
  );
  assert.equal(validate({}), false, 'verificationConfiguration is required');
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, washTradingPointsPolicy: ADDRESS.ants } }),
    false,
    'the registered policy must match the deployment record',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, verificationMinterShareBps: 5000 } }),
    false,
    'the verification bucket must stay at 10%',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, pointsPolicyCount: 0 } }),
    false,
    'M001 must activate the wash-trading points policy',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, verificationMinterEditable: false } }),
    false,
    'the verification minter must remain editable',
  );
});

for (const hasCutoverDeployment of [false, true]) {
  test(`M001 activation record preserves inherited wiring ${hasCutoverDeployment ? 'with' : 'without'} cutover deployments`, () => {
    const provenance = {
      deployedInRelease: true,
      deploymentBlock: 100,
      transactionHash: `0x${'1'.repeat(64)}`,
      runtimeCodeHash: `0x${'2'.repeat(64)}`,
      constructorArguments: [],
      owner: null,
    };
    const contracts = Object.fromEntries(Object.entries({
      washTradingRegistry: ADDRESS.registry,
      washTradingPointsPolicy: ADDRESS.sellerRegistry,
      positionInit: ADDRESS.channels,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
    }).map(([name, address]) => [name, { ...provenance, address }]));
    const checkpoint = {
      sourceCommit: 'a'.repeat(40),
      effectiveEpoch: 11,
      contracts,
      ...(hasCutoverDeployment ? {
        cutoverContracts: {
          legacyRewardsPoolRegistry: { ...provenance, address: ADDRESS.legacyEmissions, deploymentBlock: 200 },
        },
      } : {}),
    };
    const original = structuredClone(checkpoint);
    const verification = {
      washTradingRegistry: ADDRESS.registry,
      washTradingPointsPolicy: ADDRESS.sellerRegistry,
      verificationMinterController: ADDRESS.registry,
      verificationMinterShareBps: 10_000,
      verificationMinterEditable: true,
      pointsPolicyCount: 1,
      emissionsGateOwner: ADDRESS.ants,
      pointsPolicyRegistryOwner: ADDRESS.channels,
    };
    const record = buildActivationRecord({
      network: 'base-mainnet',
      canonical: { chainId: 8453 },
      expected: { legacyEmissions: ADDRESS.legacyEmissions, legacyStaking: ADDRESS.legacyStaking },
    }, checkpoint, [{
      action: 'setEmissions(address)',
      hash: `0x${'3'.repeat(64)}`,
      blockNumber: 200,
      from: ADDRESS.ants,
      to: ADDRESS.registry,
    }], verification);

    assert.equal(record.release, migration.releases[1]);
    assert.deepEqual(recordErrors(record), []);
    assert.deepEqual(migration.recordErrors(record), []);
    for (const name of Object.keys(contracts)) {
      assert.deepEqual(record.contracts[name], { ...contracts[name], deployedInRelease: false });
    }
    if (hasCutoverDeployment) {
      assert.deepEqual(record.contracts.legacyRewardsPoolRegistry, checkpoint.cutoverContracts.legacyRewardsPoolRegistry);
      assert.equal(record.contracts.legacyRewardsPoolRegistry.deployedInRelease, true);
    }
    assert.deepEqual(checkpoint, original, 'activation must not mutate deployment provenance');
  });
}

test('M001 deployment requires proof configuration instead of an existing registry', (t) => {
  const environment = {
    DEPLOYER: ADDRESS.registry,
    VERIFICATION_WALLET: ADDRESS.channels,
    BASESCAN_API_KEY: 'test-key',
    SP1_VERIFIER: ADDRESS.ants,
    SP1_VERIFIER_HASH: `0x${'1'.repeat(64)}`,
    WASH_TRADING_SELLER_PROGRAM_VKEY: `0x${'2'.repeat(64)}`,
    HISTORICAL_PERIOD_START_BLOCK: '100',
    HISTORICAL_PERIOD_END_BLOCK: '199',
  };
  const context = {
    rpcUrl: 'http://unused',
    expected: { antsToken: ADDRESS.ants, legacyEmissions: ADDRESS.legacyEmissions },
  };
  mockCast(t, (args) => {
    assert.equal(args[0], 'call');
    assert.equal(args[2], 'owner()(address)');
    return ADDRESS.registry;
  });
  assert.doesNotThrow(() => migration.verifyRoles(context, { state: 'ready' }, environment));
  for (const key of [
    'SP1_VERIFIER', 'SP1_VERIFIER_HASH', 'WASH_TRADING_SELLER_PROGRAM_VKEY',
    'HISTORICAL_PERIOD_START_BLOCK', 'HISTORICAL_PERIOD_END_BLOCK',
  ]) {
    assert.throws(
      () => migration.verifyRoles(context, { state: 'ready' }, { ...environment, [key]: undefined }),
      new RegExp(key),
    );
  }
});

test('accepts the shared record shape for baselines and executed releases alike', () => {
  const validate = (record) => recordErrors(record).length === 0;
  const baseline = {
    network: 'base-sepolia',
    chainId: 84532,
    release: '000-legacy-baseline',
    status: 'baseline',
    sourceCommit: null,
    transactions: [],
    contracts: { channels: { address: ADDRESS.channels, external: false } },
  };
  assert.equal(validate(baseline), true, 'a reconstructed baseline needs no transactions');
  assert.equal(
    validate({ ...baseline, sourceCommit: 'a'.repeat(40) }),
    false,
    'a record with known provenance must list its transactions',
  );
  assert.equal(
    validate({ ...baseline, status: 'deployed', sourceCommit: 'A'.repeat(40) }),
    false,
    'source commits must be lowercase',
  );
  assert.equal(
    validate({
      ...baseline,
      contracts: { channels: { address: ADDRESS.channels, deployedInRelease: true } },
    }),
    false,
    'a contract deployed in this release needs full provenance',
  );
});

test('never adopts a pause somebody else took', () => {
  assert.equal(pauseDecision({ simulation: true, isPaused: false }), 'skip-simulation');
  assert.equal(pauseDecision({ simulation: false, isPaused: false }), 'pause');
  assert.equal(pauseDecision({ simulation: false, isPaused: true, canAdopt: true }), 'adopt');
  assert.equal(pauseDecision({ simulation: false, isPaused: true, canAdopt: false }), 'foreign');
});

test('rejects a cutover whose registry pointers did not reach the new stack', () => {
  const expected = { expectedEmissions: ADDRESS.usageAccounting, expectedStaking: ADDRESS.sellerRegistry };
  assert.deepEqual(
    verifyPointers({ emissions: ADDRESS.usageAccounting, staking: ADDRESS.sellerRegistry, ...expected }),
    [],
  );
  assert.deepEqual(
    verifyPointers({ emissions: ADDRESS.usageAccounting.toUpperCase().replace('0X', '0x'), staking: ADDRESS.sellerRegistry, ...expected }),
    [],
    'address comparison is case-insensitive',
  );
  assert.equal(
    verifyPointers({ emissions: ADDRESS.legacyEmissions, staking: ADDRESS.sellerRegistry, ...expected }).length,
    1,
  );
  assert.equal(
    verifyPointers({ emissions: ADDRESS.legacyEmissions, staking: ADDRESS.legacyStaking, ...expected }).length,
    2,
  );
});

test('pauses one minute before the epoch boundary', () => {
  const schedule = cutoverSchedule({ genesis: 1_000, epochDuration: 100, effectiveEpoch: 5 });
  assert.equal(schedule.target, 1_500);
  assert.equal(schedule.pauseAt, 1_500 - PAUSE_LEAD_SECONDS);
});

test('leaves channels paused and explains recovery when the flip fails', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
    // The flip "runs" but never moves the pointers.
    'emissions()(address)': ADDRESS.legacyEmissions,
    'staking()(address)': ADDRESS.legacyStaking,
  };
  const sent = [];
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);

  try {
    await assert.rejects(
      runCutover(
        {
          rpcUrl: 'http://127.0.0.1:0',
          registry: ADDRESS.registry,
          usageAccounting: ADDRESS.usageAccounting,
          sellerRegistry: ADDRESS.sellerRegistry,
          simulation: false,
          pauseKey: '0xkey',
        },
        {
          log() {},
          now: () => 10_000,
          read: (_address, signature) => reads[signature],
          send: async ({ signature }) => { sent.push(signature); },
          runScript() {},
        },
      ),
      /Cutover verification FAILED/,
    );
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(sent, ['pause()'], 'channels are paused but never unpaused after a failed flip');
  assert.match(errors.join('\n'), /REMAINS PAUSED/);
});

test('unpauses after a verified flip', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
    'emissions()(address)': ADDRESS.usageAccounting,
    'staking()(address)': ADDRESS.sellerRegistry,
  };
  const sent = [];
  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      simulation: false,
      pauseKey: '0xkey',
    },
    {
      log() {},
      now: () => 10_000,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      runScript() {},
    },
  );

  assert.deepEqual(sent, ['pause()', 'unpause()']);
  assert.equal(result.endStateVerified, true);
  assert.equal(result.pauseOwned, false);
});

test('a dry run uses only a disposable fork and neither pauses nor verifies live state', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
  };
  const sent = [];
  const forkRequests = [];
  const scriptRpcs = [];
  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      chainId: 84532,
      simulation: true,
      pauseOwner: ADDRESS.ants,
    },
    {
      log() {},
      now: () => 10_000,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      withFork: async (request, body) => {
        forkRequests.push(request);
        return body({ rpcUrl: 'http://127.0.0.1:9999' });
      },
      runScript({ rpcUrl }) { scriptRpcs.push(rpcUrl); },
    },
  );

  assert.deepEqual(sent, [], 'a simulation never sends a transaction');
  assert.equal(result.endStateVerified, false);
  assert.equal(forkRequests[0].forkUrl, 'http://127.0.0.1:0');
  assert.equal(forkRequests[0].timestamp, undefined);
  assert.deepEqual(scriptRpcs, ['http://127.0.0.1:9999']);
  assert.equal(result.beforeTransactions[0].function, 'pause()');
  assert.equal(result.afterTransactions[0].function, 'unpause()');
});

test('a dry run before the epoch boundary simulates instead of waiting', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '10',
    // The boundary is still far ahead: a broadcast would block here.
    'currentEpoch()(uint256)': '1',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
  };
  const sent = [];
  const waited = [];
  const forkRequests = [];
  const scriptRpcs = [];

  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      chainId: 84532,
      simulation: true,
      pauseOwner: ADDRESS.ants,
    },
    {
      log() {},
      now: () => 0,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      waitUntil: async (deadline) => { waited.push(deadline); },
      withFork: async (request, body) => {
        forkRequests.push(request);
        return body({ rpcUrl: 'http://127.0.0.1:9998' });
      },
      runScript({ rpcUrl }) { scriptRpcs.push(rpcUrl); },
    },
  );

  assert.deepEqual(waited, [], 'a simulation never waits for the epoch boundary');
  assert.deepEqual(sent, [], 'a simulation never sends a transaction');
  assert.equal(forkRequests[0].timestamp, 1001, 'only the disposable fork advances past the boundary');
  assert.deepEqual(scriptRpcs, ['http://127.0.0.1:9998']);
  assert.equal(result.endStateVerified, false);
});

// ---------------------------------------------------------------------------
// M002 — legacy seller claims
// ---------------------------------------------------------------------------

const M002_ADDRESS = {
  pool: '0x0000000000000000000000000000000000000010',
  policy: '0x0000000000000000000000000000000000000011',
  foreignPolicy: '0x0000000000000000000000000000000000000012',
  zero: '0x0000000000000000000000000000000000000000',
};

function m002Observation(overrides = {}) {
  return {
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      usageAccounting: ADDRESS.usageAccounting,
      recordedPolicy: null,
    },
    registry: { antsToken: ADDRESS.ants, emissions: ADDRESS.usageAccounting },
    legacyEmissionsV2: ADDRESS.legacyEmissions,
    token: { owner: ADDRESS.ants, transfersEnabled: false, poolWhitelisted: false },
    pool: {
      address: M002_ADDRESS.pool,
      owner: ADDRESS.channels,
      sellerClaimPolicy: M002_ADDRESS.zero,
      policyMatchesRecord: true,
    },
    lastLockedEpochValid: true,
    ...overrides,
  };
}

test('classifies the M002 lifecycle', () => {
  assert.equal(classifyM002(m002Observation()), 'ready');
  // Half-applied installs stay `ready` so the idempotent script finishes them.
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: false, poolWhitelisted: true },
  })), 'ready');
  assert.equal(classifyM002(m002Observation({
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'ready');
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: false, poolWhitelisted: true },
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'active');
  // Globally enabled transfers make the whitelist unnecessary.
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: true, poolWhitelisted: false },
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'active');
});

test('M002 refuses to run before M001 activates or over a foreign policy', () => {
  assert.equal(classifyM002(m002Observation({
    registry: { antsToken: ADDRESS.ants, emissions: ADDRESS.legacyEmissions },
  })), 'invalid', 'registry.emissions() still legacy');
  assert.equal(classifyM002(m002Observation({ pool: null })), 'not-applicable', 'V1-only legacy emissions, no pool');
  assert.equal(classifyM002(m002Observation({ legacyEmissionsV2: null })), 'invalid', 'escrow points at nothing');
  assert.equal(classifyM002(m002Observation({ lastLockedEpochValid: false })), 'invalid', 'effective epoch <= migration');
  assert.equal(classifyM002(m002Observation({
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.foreignPolicy, policyMatchesRecord: false },
  })), 'invalid', 'a policy this ledger did not install');
});

test('M002 supports the same networks and modes as M001', () => {
  assert.doesNotThrow(() => validateM002Options({ network: 'base-sepolia', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM002Options({ network: 'base-mainnet', mode: 'fork-test' }));
  assert.throws(() => validateM002Options({ network: 'base-sepolia', mode: 'fork-test' }), /M002 supports/);
  assert.throws(() => validateM002Options({ network: 'base-local', mode: 'dry-run' }), /M002 supports/);
});

test('M002 defaults to ten percent of cumulative locked rewards', () => {
  assert.equal(DEFAULT_RELEASE_BPS, 1000);
});

test('M002 requires an activated M001 baseline', () => {
  const contract = (address) => ({ address });
  const activated = {
    network: 'base-mainnet',
    contracts: {
      registry: contract(ADDRESS.registry),
      antsToken: contract(ADDRESS.ants),
      emissions: contract(ADDRESS.usageAccounting),
      usageAccounting: contract(ADDRESS.usageAccounting),
      washTradingRegistry: contract(ADDRESS.channels),
      legacyEmissionsEscrow: contract(ADDRESS.sellerRegistry),
    },
  };
  assert.doesNotThrow(() => validateM002Baseline(activated));
  assert.equal(m002.expectedState(activated).washTradingRegistry, ADDRESS.channels);
  assert.throws(
    () => validateM002Baseline({ ...activated, contracts: { ...activated.contracts, emissions: contract(ADDRESS.legacyEmissions) } }),
    /run M001 first/,
  );
  const { washTradingRegistry, ...withoutWashTradingRegistry } = activated.contracts;
  assert.throws(() => validateM002Baseline({ ...activated, contracts: withoutWashTradingRegistry }), /missing: washTradingRegistry/);
});

test('M002 observes the ledger wash registry without a PositionInit getter', async (t) => {
  const responses = {
    'legacyEmissions()(address)': ADDRESS.legacyEmissions,
    'sellerRewardsPool()(address)': M002_ADDRESS.pool,
    'owner()(address)': ADDRESS.ants,
    'sellerClaimPolicy()(address)': M002_ADDRESS.zero,
    'totalLockedRewards()(uint256)': '1000',
    'emissionsGate()(address)': ADDRESS.channels,
    'effectiveEpoch()(uint256)': '22',
    'MIGRATION_EPOCH()(uint256)': '4',
    'antsToken()(address)': ADDRESS.ants,
    'emissions()(address)': ADDRESS.usageAccounting,
    'transfersEnabled()(bool)': 'false',
    'transferWhitelist(address)(bool)': 'false',
  };
  mockCast(t, (args) => {
    if (args[0] === 'chain-id') return '8453';
    if (args[0] === 'code') return '0x01';
    assert.equal(args[0], 'call');
    assert.ok(Object.hasOwn(responses, args[2]), `unexpected getter: ${args[2]}`);
    return responses[args[2]];
  });
  const observation = await m002.observe({
    rpcUrl: 'http://127.0.0.1:0',
    network: 'base-mainnet',
    canonical: { chainId: 8453 },
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      usageAccounting: ADDRESS.usageAccounting,
      legacyEmissionsEscrow: ADDRESS.sellerRegistry,
      washTradingRegistry: ADDRESS.channels,
      recordedPolicy: null,
    },
  });
  assert.equal(observation.state, 'ready');
  assert.equal(observation.washTradingRegistry, ADDRESS.channels);
});

test('enforces M002 release invariants', () => {
  const validate = (record) => m002.recordErrors(record).length === 0;
  const verificationConfiguration = {
    sellerRewardsPool: M002_ADDRESS.pool,
    sellerClaimPolicy: M002_ADDRESS.policy,
    poolCanTransfer: true,
    lastLockedEpoch: 41,
    releaseBps: 1000,
    washTradingRegistry: ADDRESS.channels,
  };
  const contracts = { legacySellerClaimPolicy: { address: M002_ADDRESS.policy } };

  assert.equal(validate({ verificationConfiguration, contracts }), true);
  assert.equal(validate({}), false, 'verificationConfiguration is required');
  assert.equal(validate({ verificationConfiguration }), false, 'the deployed policy must be recorded');
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, poolCanTransfer: false }, contracts }),
    false,
    'the pool must be able to send ANTS',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, releaseBps: 0 }, contracts }),
    false,
    'a zero release is a frozen pool',
  );
  assert.equal(
    validate({
      verificationConfiguration,
      contracts: { legacySellerClaimPolicy: { address: M002_ADDRESS.foreignPolicy } },
    }),
    false,
    'the recorded contract must be the installed policy',
  );
});

test('M002 has a single idempotent install phase owned by two signers', () => {
  assert.deepEqual(m002.releases, ['002-legacy-seller-claims']);
  assert.deepEqual(m002.phases.map((phase) => phase.id), ['install']);
  assert.deepEqual(m002.phases[0].signers(), ['deployer', 'sellerRewardsPoolOwner']);
  assert.equal(m002.phases[0].guard({ state: 'ready' }), true);
  assert.equal(m002.phases[0].guard({ state: 'active' }), false);
  assert.deepEqual(m002.allowedDirtyReleases({ state: 'ready' }), []);
  assert.deepEqual(buildReleaseOwners().get('002-legacy-seller-claims'), m002);
});

test('M002 rehearses through the framework with M001 as its prerequisite', () => {
  assert.deepEqual(m002.rehearsal.prerequisites, ['M001']);
  assert.equal(m002.rehearsal.fork, undefined);
  const result = resolveRehearsal(m002, { ...REHEARSAL_OPTIONS, migration: 'M002' }, deploymentMigrations);
  assert.deepEqual(result.migrations.map((entry) => entry.id), ['M001', 'M002']);
  assert.deepEqual(result.fork, migration.rehearsal.fork);
});

test('M002 rehearsal checks activation and an idempotent second apply', async () => {
  for (const states of [['active', 'active'], ['ready'], ['active', 'ready']]) {
    const driven = [];
    const run = m002.rehearsal.run({
      network: 'base-mainnet',
      async runMigration(overrides) {
        driven.push(overrides);
        return { state: states[driven.length - 1] };
      },
    });
    if (states.every((state) => state === 'active')) await run;
    else await assert.rejects(run, /Expected M002 active|not an active no-op/);
    assert.equal(driven.length, states.length);
    assert.deepEqual(Object.keys(driven[0].signers), ['deployer', 'sellerRewardsPoolOwner']);
    assert.ok(Object.values(driven[0].signers).every((signer) => signer.startsWith('unlocked:')));
  }
});

test('chain config exposes deployed M001 addresses without activating legacy aliases', async () => {
  const current = {
    chainId: 8453,
    status: 'active',
    contracts: {
      emissions: { address: '0x0000000000000000000000000000000000000001' },
      staking: { address: '0x0000000000000000000000000000000000000002' },
    },
  };
  const deployed = JSON.parse(await readFile('packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json', 'utf8'));
  const config = renderNetwork(current, deployed);
  assert.equal(config.stakingContractAddress, current.contracts.staking.address);
  assert.equal(config.emissionsContractAddress, current.contracts.emissions.address);
  assert.equal(config.recognizedUsage.status, 'deployed');
  assert.equal(config.recognizedUsage.effectiveEpoch, deployed.effectiveEpoch);
  assert.equal(Object.keys(config.recognizedUsage.contracts).length, 11);
  for (const [name, contract] of Object.entries(deployed.contracts)) {
    assert.equal(config.recognizedUsage.contracts[name], contract.address);
  }
});

test('chain config activates M001 metadata only after both active aliases match', async () => {
  const current = {
    chainId: 8453,
    status: 'active',
    contracts: {
      emissions: { address: '0x0000000000000000000000000000000000000001' },
      staking: { address: '0x0000000000000000000000000000000000000002' },
    },
  };
  const deployed = JSON.parse(await readFile('packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json', 'utf8'));
  current.contracts.emissions = deployed.contracts.usageAccounting;
  assert.equal(renderNetwork(current, deployed).recognizedUsage.status, 'deployed');
  current.contracts.staking = deployed.contracts.sellerRegistry;
  const config = renderNetwork(current, deployed);
  assert.equal(config.recognizedUsage.status, 'active');
  assert.equal(config.emissionsContractAddress, deployed.contracts.usageAccounting.address);
  assert.equal(config.stakingContractAddress, deployed.contracts.sellerRegistry.address);
});

test('chain config does not invent an M001 deployment on another network', async () => {
  const current = JSON.parse(await readFile('packages/contracts/deployments/base-sepolia/current.json', 'utf8'));
  assert.equal(renderNetwork(current).recognizedUsage, undefined);
});

test('published M001 address inventories match the immutable deployment record', async () => {
  const deployed = JSON.parse(await readFile('packages/contracts/deployments/base-mainnet/history/001-recognized-usage-deployed.json', 'utf8'));
  for (const file of ['packages/contracts/README.md', 'apps/website/docs/protocol/recognized-usage.md']) {
    const document = (await readFile(file, 'utf8')).toLowerCase();
    for (const [name, contract] of Object.entries(deployed.contracts)) {
      assert.ok(document.includes(contract.address.toLowerCase()), `${file} is missing ${name}`);
    }
  }
});

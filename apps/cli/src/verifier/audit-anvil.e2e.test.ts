import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Wallet, getAddress } from 'ethers'
import { VERIFIER_VERDICT, VerifierClient, modelHash } from '@antseed/node/payments'
import {
  FIXTURE_CONFIG,
  referenceFixture,
  writeSignedAuditRun,
  type FixtureAudit,
} from './model-audit-fixtures.test-support.js'
import { loadEpochReports, pendingConfirmations } from './pending-confirmations.js'
import { roundRobinAssignmentFor, auditorRotationForModel } from './audit-assignment.js'
import { handoverModelsFor, loadEpochModelAudits } from './audit-handover.js'
import { chainNow } from './chain-clock.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AUDITOR_PRIVATE_KEY = '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const UNAPPROVED_PRIVATE_KEY = '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e'
const SECOND_AUDITOR_PRIVATE_KEY = '4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'
const AUDIT_EPOCH = 5
const SELLER_OWNERS = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
] as const
const RUN_ID = 'anvil-audit-run'
const EPOCH = String(AUDIT_EPOCH)
/** Puts epoch AUDIT_EPOCH on 2026-10-07 (UTC), where the fixture run's timestamps fall. */
const EPOCH_DURATION = 86_400
const GENESIS = Date.parse('2026-10-07T00:00:00.000Z') / 1_000 - AUDIT_EPOCH * EPOCH_DURATION

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(compiledTestDirectory, '../../../..')
const contractsDirectory = join(repoRoot, 'packages', 'contracts')
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli', 'index.js')

interface CommandResult {
  status: number
  output: string
  stdout: string
}

interface RunCliOptions {
  env?: NodeJS.ProcessEnv
  importPath?: string
}

test('an approved auditor submits one audit per model, earns credits, and a re-run is a no-op', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-audit-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
    const { resultsAddress, kbfAddress: verificationAddress } = deployVerification(rpcUrl, gateAddress, poolsAddress, identityRegistryAddress)
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
    castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(GENESIS), String(EPOCH_DURATION)])
    const auditor = new Wallet(`0x${AUDITOR_PRIVATE_KEY}`)
    castSend(rpcUrl, verificationAddress, 'setAuditor(address,bool)', [auditor.address, 'true'])
    // Rewards are off until the owner sets a start epoch.
    castSend(rpcUrl, resultsAddress, 'setRewardsStartEpoch(address,uint64)', [verificationAddress, '0'])
    // Agent 3 belongs to the auditor, who must not audit it.
    const owners = [...SELLER_OWNERS, auditor.address]
    for (const [index, owner] of owners.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
    }
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['1', String(AUDIT_EPOCH), '300'])
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['2', String(AUDIT_EPOCH), '100'])

    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    const audits: FixtureAudit[] = [
      { agentId: '1', seller: sellers[0]!, model: 'model-a', service: 'model-a', verdict: 'SAME', reference: referenceFixture('model-a') },
      { agentId: '1', seller: sellers[0]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: referenceFixture('model-b') },
      { agentId: '2', seller: sellers[1]!, model: 'model-a', service: 'model-a', verdict: 'DIFF', reference: referenceFixture('model-a') },
      { agentId: '2', seller: sellers[1]!, model: 'model-b', service: 'model-b', verdict: 'UNDETERMINED', reference: referenceFixture('model-b') },
      { agentId: '3', seller: sellers[2]!, model: 'model-b', service: 'model-b', verdict: 'SAME', reference: referenceFixture('model-b') },
    ]
    const crypto = {
      chainId: 'base-local',
      rpcUrl,
      verificationContractAddress: verificationAddress,
      verificationDeployBlock: 0,
      identityRegistryAddress,
    }
    const setUpDataDir = async (name: string, key: string) => {
      const dataDir = join(directory, name)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${key}\n`, { mode: 0o600 })
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto },
        verifier: { evidenceDir, banksDir, ...FIXTURE_CONFIG },
      }))
      await writeSignedAuditRun({ evidenceDir, banksDir, runId: RUN_ID, epoch: EPOCH, auditor: new Wallet(`0x${key}`), audits })
      return { dataDir, configPath, evidenceDir }
    }
    const approved = await setUpDataDir('auditor', AUDITOR_PRIVATE_KEY)
    const unapproved = await setUpDataDir('unapproved', UNAPPROVED_PRIVATE_KEY)

    const pinataLogPath = join(directory, 'pinata-uploads.jsonl')
    const pinataPreloadPath = join(directory, 'mock-pinata.mjs')
    await writeMockPinataPreload(pinataPreloadPath, pinataLogPath)
    const submit = (dirs: typeof approved, extra: string[]) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', RUN_ID, '--skip-version-check', ...extra,
    ], { importPath: pinataPreloadPath, env: { PINATA_JWT: 'test-pinata-jwt' } })
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })

    const dryRun = submit(approved, ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.match(dryRun.output, /Dry run complete/)
    assert.match(dryRun.output, /self-audit/)
    assert.equal((await client.queryModelAudits()).length, 0)

    const refused = submit(unapproved, ['--yes'])
    assert.equal(refused.status, 1, refused.output)
    assert.match(refused.output, /not approved/)

    const first = submit(approved, ['--yes'])
    assert.equal(first.status, 0, first.output)
    assert.match(first.output, /Submitted: 2; recovered: 0; already submitted: 0; failed: 0/)
    const uploads = (await readFile(pinataLogPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as {
      model: string
      files: string[]
    })
    assert.deepEqual(uploads.map((upload) => upload.model).sort(), ['model-a', 'model-b'])

    const repeat = submit(approved, ['--yes'])
    assert.equal(repeat.status, 0, repeat.output)
    assert.match(repeat.output, /Nothing to submit/)

    const onChain = await client.queryModelAudits()
    assert.equal(onChain.length, 2)
    assert.ok(onChain.every((audit) => audit.auditor === auditor.address
      && audit.epoch === BigInt(AUDIT_EPOCH)
      && audit.evidenceUri.startsWith('ipfs://')))
    assert.deepEqual(onChain.map((audit) => audit.modelHash).sort(), [modelHash('model-a'), modelHash('model-b')].sort())
    assert.equal(await client.isVerified(1n), true)
    assert.equal(await client.isVerified(2n), false)
    assert.equal(await client.isVerified(3n), false)
    assert.equal((await client.queryServiceAudits(1n)).length, 2)
    const undetermined = await client.serviceStatus(2n, 'model-b')
    assert.equal(undetermined.verdict, VERIFIER_VERDICT.UNDETERMINED)
    assert.deepEqual(await client.auditCredits(auditor.address, AUDIT_EPOCH), { auditor: 2n, total: 2n })

    assert.equal(await client.emissionsGate(), getAddress(gateAddress))
    assert.equal(await client.validityEpochs(), 2)
    assert.equal((await client.serviceStatus(1n, 'model-a')).epoch, BigInt(AUDIT_EPOCH))
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 2, diffCount: 0 })
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'one auditor\'s DIFF waits for a second')
    assert.equal((await client.serviceStatus(2n, 'model-a')).verdict, VERIFIER_VERDICT.NONE)
    assert.match(first.output, /model-a: 1 recorded, 1 waiting for another auditor/)
    assert.match(first.output, /agent 2: DIFF 1\/2/)

    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 1)])
    assert.equal(await client.isVerified(1n), true, 'still counts in the next epoch')
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 2)])
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 0, diffCount: 0 })
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 })
    assert.equal(await client.isVerified(1n), false, 'verdicts expire without any cleanup transaction')
    assert.equal((await client.serviceStatus(1n, 'model-a')).verdict, VERIFIER_VERDICT.SAME, 'expired verdict stays readable')

    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 1)])
    const stale = submit(approved, ['--yes'])
    assert.equal(stale.status, 1, stale.output)
    assert.match(stale.output, new RegExp(`current on-chain epoch is ${AUDIT_EPOCH + 1}`))
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('two auditors confirm each other\'s DIFFs: one SAME is recorded at once, a DIFF once the other auditor reports it', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-confirm-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
    const { resultsAddress, kbfAddress: verificationAddress } = deployVerification(rpcUrl, gateAddress, poolsAddress, identityRegistryAddress)
    castSend(rpcUrl, resultsAddress, 'setRewardsStartEpoch(address,uint64)', [verificationAddress, '0'])
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
    castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(GENESIS), String(EPOCH_DURATION)])
    const auditorA = new Wallet(`0x${AUDITOR_PRIVATE_KEY}`)
    const auditorB = new Wallet(`0x${SECOND_AUDITOR_PRIVATE_KEY}`)
    for (const auditor of [auditorA, auditorB]) {
      castSend(rpcUrl, verificationAddress, 'setAuditor(address,bool)', [auditor.address, 'true'])
    }
    for (const [index, owner] of SELLER_OWNERS.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
      castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', [String(index + 1), String(AUDIT_EPOCH), '100'])
    }

    // Seller 1 is honest; seller 2 does not serve either model. A audits model-a and B model-b.
    const sellers = [randomWallet(), randomWallet()]
    const audit = (agent: 1 | 2, model: string): FixtureAudit => ({
      agentId: String(agent),
      seller: sellers[agent - 1]!,
      model,
      service: model,
      verdict: agent === 1 ? 'SAME' : 'DIFF',
      reference: referenceFixture(model),
    })
    const crypto = {
      chainId: 'base-local',
      rpcUrl,
      verificationContractAddress: verificationAddress,
      verificationDeployBlock: 0,
      identityRegistryAddress,
    }
    const setUpDataDir = async (name: string, key: string) => {
      const dataDir = join(directory, name)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${key}\n`, { mode: 0o600 })
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto },
        verifier: { evidenceDir, banksDir, ...FIXTURE_CONFIG },
      }))
      const auditor = new Wallet(`0x${key}`)
      const writeRun = (runId: string, audits: FixtureAudit[]) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor, audits })
      )
      return { dataDir, configPath, writeRun }
    }
    const a = await setUpDataDir('auditor-a', AUDITOR_PRIVATE_KEY)
    const b = await setUpDataDir('auditor-b', SECOND_AUDITOR_PRIVATE_KEY)
    const submit = (dirs: typeof a, runId: string) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', runId, '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
    const pendingFor = async (auditor: string) => pendingConfirmations({
      reports: await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: 0 }),
      epoch: AUDIT_EPOCH,
      epochStartedAt,
      epochEndsAt: epochStartedAt + EPOCH_DURATION,
      now: epochStartedAt + 60,
      auditor,
      auditors: [auditorA.address, auditorB.address],
      auditedModels: ['model-a', 'model-b'],
    }).map((entry) => ({
      model: entry.model, agentId: entry.agentId, waiting: entry.waiting, confirmer: entry.confirmer, mine: entry.mine,
    }))

    assert.deepEqual(await client.requiredReports(), { SAME: 1, DIFF: 2, UNDETERMINED: 1 })

    await a.writeRun('a-model-a', [audit(1, 'model-a'), audit(2, 'model-a')])
    await b.writeRun('b-model-b', [audit(1, 'model-b'), audit(2, 'model-b')])
    const reportedA = submit(a, 'a-model-a')
    assert.equal(reportedA.status, 0, reportedA.output)
    assert.match(reportedA.output, /model-a: 1 recorded, 1 waiting for another auditor/)
    assert.match(reportedA.output, /agent 2: DIFF 1\/2/)
    const reportedB = submit(b, 'b-model-b')
    assert.equal(reportedB.status, 0, reportedB.output)
    assert.match(reportedB.output, /model-b: 1 recorded, 1 waiting for another auditor/)
    assert.equal(await client.isVerified(1n), true, 'one SAME verifies')
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'one DIFF is only a report')

    // Each auditor is the confirmer of the other's DIFF.
    const waitingDiff = [{ verdict: 'DIFF', reports: 1, required: 2 }]
    assert.deepEqual(await pendingFor(auditorA.address), [
      { model: 'model-a', agentId: 2n, waiting: waitingDiff, confirmer: auditorB.address, mine: false },
      { model: 'model-b', agentId: 2n, waiting: waitingDiff, confirmer: auditorA.address, mine: true },
    ])
    assert.deepEqual((await pendingFor(auditorB.address)).map((entry) => [entry.model, entry.mine]), [
      ['model-a', true], ['model-b', false],
    ])

    // Each confirms with its own audit of the other's model.
    await a.writeRun('a-confirm-model-b', [audit(2, 'model-b')])
    await b.writeRun('b-confirm-model-a', [audit(2, 'model-a')])
    const confirmedByB = submit(b, 'b-confirm-model-a')
    assert.equal(confirmedByB.status, 0, confirmedByB.output)
    assert.match(confirmedByB.output, /model-a: 1 recorded, 0 waiting for another auditor/)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })
    const confirmedByA = submit(a, 'a-confirm-model-b')
    assert.equal(confirmedByA.status, 0, confirmedByA.output)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 2 })
    assert.equal(await client.isVerified(2n), false)
    assert.equal(await client.isVerified(1n), true)
    assert.deepEqual(await pendingFor(auditorA.address), [])
    assert.deepEqual(await pendingFor(auditorB.address), [])
    const events = await client.queryServiceAudits(2n, null, 0)
    assert.deepEqual(events.map(({ auditor, reports, required }) => [auditor, reports, required]), [
      [auditorA.address, 1, 2], [auditorB.address, 1, 2], [auditorB.address, 2, 2], [auditorA.address, 2, 2],
    ])
    assert.deepEqual(await client.auditCredits(auditorA.address, AUDIT_EPOCH), { auditor: 2n, total: 4n })
    assert.deepEqual(await client.auditCredits(auditorB.address, AUDIT_EPOCH), { auditor: 2n, total: 4n })

    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 1)])
    assert.equal(await client.isVerified(2n), false, 'a confirmed DIFF still counts in the next epoch')
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH + 2)])
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'and expires after it')
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a model whose auditor is absent is handed to the next active auditor from halfway through the epoch', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-handover-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
  // The chain starts two minutes before the epoch, so the auditors are approved before it starts and
  // its clock, not the wall clock, says how far the epoch has come.
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
    const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
    const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
    const { resultsAddress, kbfAddress: verificationAddress } = deployVerification(rpcUrl, gateAddress, poolsAddress, identityRegistryAddress)
    castSend(rpcUrl, resultsAddress, 'setRewardsStartEpoch(address,uint64)', [verificationAddress, '0'])
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
    castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(GENESIS), String(EPOCH_DURATION)])
    // Three approved auditors; the third never audits.
    const wallets = {
      a: new Wallet(`0x${AUDITOR_PRIVATE_KEY}`),
      b: new Wallet(`0x${SECOND_AUDITOR_PRIVATE_KEY}`),
      lazy: new Wallet(`0x${UNAPPROVED_PRIVATE_KEY}`),
    }
    for (const auditor of Object.values(wallets)) {
      castSend(rpcUrl, verificationAddress, 'setAuditor(address,bool)', [auditor.address, 'true'])
    }
    castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', ['1', SELLER_OWNERS[0]])
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['1', String(AUDIT_EPOCH), '100'])

    // Three built-in models, one per auditor this epoch.
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3']
    const auditors = Object.values(wallets).map((wallet) => wallet.address)
    const rotation = { auditors, epoch: AUDIT_EPOCH, availableModels: models }
    const assigned = (auditor: Wallet) => roundRobinAssignmentFor(auditor.address, rotation).models
    assert.equal(assigned(wallets.lazy).length, 1)
    const lazyModel = assigned(wallets.lazy)[0]!
    const [, standInAddress] = auditorRotationForModel(lazyModel, rotation)
    const standIn = Object.values(wallets).find((wallet) => wallet.address === standInAddress)!
    const other = Object.values(wallets).find((wallet) => wallet !== standIn && wallet !== wallets.lazy)!

    const seller = randomWallet()
    const audit = (model: string): FixtureAudit => ({
      agentId: '1', seller, model, service: model, verdict: 'SAME', reference: referenceFixture(model),
    })
    const crypto = {
      chainId: 'base-local',
      rpcUrl,
      verificationContractAddress: verificationAddress,
      verificationDeployBlock: 0,
      identityRegistryAddress,
    }
    const setUpDataDir = async (name: string, wallet: Wallet) => {
      const dataDir = join(directory, name)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${wallet.privateKey.slice(2)}\n`, { mode: 0o600 })
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto },
        verifier: { evidenceDir, banksDir, auditor: wallet.address, testModels: models, ...FIXTURE_CONFIG },
      }))
      const writeRun = (runId: string, audits: FixtureAudit[]) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor: wallet, audits })
      )
      return { dataDir, configPath, writeRun }
    }
    const dirs = { standIn: await setUpDataDir('stand-in', standIn), other: await setUpDataDir('other', other) }
    const submit = (who: keyof typeof dirs, runId: string) => runCli(dirs[who].dataDir, dirs[who].configPath, rpcUrl, [
      'submit', '--run-id', runId, '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    interface AssignmentJson {
      epochs: Array<{ epoch: string; handovers: Array<{ model: string; assignedAuditor: string; standIn: string; stage: number }> }>
    }
    const handoversShown = (who: keyof typeof dirs) => {
      const result = runCli(dirs[who].dataDir, dirs[who].configPath, null, ['assignment', '--json'])
      assert.equal(result.status, 0, result.output)
      return (JSON.parse(result.stdout) as AssignmentJson).epochs[0]!.handovers
    }
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const provider = client.provider
    const handoversFor = async (auditor: string) => handoverModelsFor(auditor, {
      ...rotation,
      audits: await loadEpochModelAudits({ reader: client, epoch: AUDIT_EPOCH, epochStartedAt, deploymentBlock: 0 }),
      epochStartedAt,
      epochEndsAt: epochStartedAt + EPOCH_DURATION,
      now: await chainNow(provider),
    })

    // The two active auditors audit their own model, early in the epoch (the chain moves into it first).
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    await dirs.standIn.writeRun('stand-in-own', [audit(assigned(standIn)[0]!)])
    await dirs.other.writeRun('other-own', [audit(assigned(other)[0]!)])
    for (const who of ['standIn', 'other'] as const) {
      const result = submit(who, `${who === 'standIn' ? 'stand-in' : 'other'}-own`)
      assert.equal(result.status, 0, result.output)
    }
    assert.deepEqual(await client.auditCredits(standIn.address, AUDIT_EPOCH), { auditor: 1n, total: 2n })
    const before = await chainNow(provider)
    assert.ok(before >= epochStartedAt && before < epochStartedAt + EPOCH_DURATION / 2, `chain time ${before} is early in the epoch`)
    assert.deepEqual(await handoversFor(standIn.address), [], 'nothing is handed over before halfway')
    assert.deepEqual(handoversShown('standIn'), [])

    // Halfway through the epoch: the lazy auditor's model goes to the next active auditor in its rotation.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 2])
    await rpc(rpcUrl, 'evm_mine', [])
    const after = await chainNow(provider)
    assert.ok(after >= epochStartedAt + EPOCH_DURATION / 2, `chain time ${after} is past halfway`)
    assert.ok(after < epochStartedAt + EPOCH_DURATION * 0.75, `chain time ${after} is before three quarters`)
    const expected = [{ model: lazyModel, assignedAuditor: wallets.lazy.address, standIn: standIn.address, stage: 1 }]
    assert.deepEqual(await handoversFor(standIn.address), expected)
    assert.deepEqual(await handoversFor(other.address), [])
    assert.deepEqual(handoversShown('standIn'), expected, 'verifier assignment shows the stand-in')
    assert.deepEqual(handoversShown('other'), expected)

    // The stand-in audits it like any other model, and the contract credits the audit.
    await dirs.standIn.writeRun('stand-in-handover', [audit(lazyModel)])
    const handedOver = submit('standIn', 'stand-in-handover')
    assert.equal(handedOver.status, 0, handedOver.output)
    assert.deepEqual(await client.auditCredits(standIn.address, AUDIT_EPOCH), { auditor: 2n, total: 3n })
    assert.deepEqual(await client.auditCredits(wallets.lazy.address, AUDIT_EPOCH), { auditor: 0n, total: 3n })
    const events = await client.queryModelAudits({ model: modelHash(lazyModel) }, 0)
    assert.deepEqual(events.map((event) => [event.auditor, event.epoch]), [[standIn.address, BigInt(AUDIT_EPOCH)]])
    assert.deepEqual(await handoversFor(standIn.address), [], 'once audited, the model is no longer handed over')
    assert.deepEqual(handoversShown('standIn'), [])
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a DIFF whose confirmer never reports is confirmed by another auditor from halfway through the epoch', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-absent-confirmer-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    // Three approved auditors; the third never runs.
    const wallets = [AUDITOR_PRIVATE_KEY, SECOND_AUDITOR_PRIVATE_KEY, UNAPPROVED_PRIVATE_KEY].map((key) => new Wallet(`0x${key}`))
    const absent = wallets[2]!
    const chain = deployAuditChain(rpcUrl, wallets, 1)
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3']
    const rotation = { auditors: wallets.map((wallet) => wallet.address), epoch: AUDIT_EPOCH, availableModels: models }
    // The model whose DIFFs the absent auditor is to confirm: it is second in that model's rotation.
    const model = models.find((entry) => auditorRotationForModel(entry, rotation)[1] === absent.address)!
    const [reporterAddress, , fallbackAddress] = auditorRotationForModel(model, rotation)
    const reporter = wallets.find((wallet) => wallet.address === reporterAddress)!
    const fallback = wallets.find((wallet) => wallet.address === fallbackAddress)!
    assert.ok(reporter !== absent && fallback !== absent && reporter !== fallback)

    const seller = randomWallet()
    const diff: FixtureAudit = { agentId: '1', seller, model, service: model, verdict: 'DIFF', reference: referenceFixture(model) }
    const dirs = {
      reporter: await auditorDataDir(directory, 'reporter', reporter, chain.crypto, models),
      fallback: await auditorDataDir(directory, 'fallback', fallback, chain.crypto, models),
    }
    const submit = (who: keyof typeof dirs, runId: string) => runCli(dirs[who].dataDir, dirs[who].configPath, rpcUrl, [
      'submit', '--run-id', runId, '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    // What `verifier run` works out for each auditor, on the chain's clock.
    const pendingFor = async (auditor: Wallet) => pendingConfirmations({
      reports: await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: 0 }),
      epoch: AUDIT_EPOCH,
      epochStartedAt,
      epochEndsAt: epochStartedAt + EPOCH_DURATION,
      now: await chainNow(client.provider),
      auditor: auditor.address,
      auditors: rotation.auditors,
      auditedModels: models,
    }).map((entry) => ({
      model: entry.model, agentId: entry.agentId, waiting: entry.waiting, confirmer: entry.confirmer, mine: entry.mine,
    }))
    const waiting = (mine: boolean) => [{
      model, agentId: 1n, waiting: [{ verdict: 'DIFF', reports: 1, required: 2 }], confirmer: absent.address, mine,
    }]

    // Early in the epoch one auditor reports a DIFF. Its confirmer is the absent auditor.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    await dirs.reporter.writeRun('reporter-diff', [diff])
    const reported = submit('reporter', 'reporter-diff')
    assert.equal(reported.status, 0, reported.output)
    assert.ok(reported.output.includes(`${model}: 0 recorded, 1 waiting for another auditor`), reported.output)
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 0, diffCount: 0 }, 'one DIFF is only a report')
    assert.deepEqual(await pendingFor(absent), waiting(true))
    assert.deepEqual(await pendingFor(fallback), waiting(false), 'before halfway the third auditor leaves it to the confirmer')
    assert.deepEqual(await pendingFor(reporter), waiting(false))

    // Halfway through the epoch the confirmer still has not reported: the third auditor takes it.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 2])
    await rpc(rpcUrl, 'evm_mine', [])
    assert.ok(await chainNow(client.provider) >= epochStartedAt + EPOCH_DURATION / 2)
    assert.deepEqual(await pendingFor(fallback), waiting(true))
    assert.deepEqual(await pendingFor(reporter), waiting(false), 'the reporter never confirms its own DIFF')

    // It audits the seller itself, also finds DIFF, and the contract records the DIFF.
    await dirs.fallback.writeRun('fallback-confirm', [diff])
    const confirmed = submit('fallback', 'fallback-confirm')
    assert.equal(confirmed.status, 0, confirmed.output)
    assert.ok(confirmed.output.includes(`${model}: 1 recorded, 0 waiting for another auditor`), confirmed.output)
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 0, diffCount: 1 })
    assert.equal(await client.isVerified(1n), false)
    const events = await client.queryServiceAudits(1n, null, 0)
    assert.deepEqual(events.map(({ auditor, reports, required }) => [auditor, reports, required]), [
      [reporter.address, 1, 2], [fallback.address, 2, 2],
    ])
    for (const auditor of wallets) assert.deepEqual(await pendingFor(auditor), [], 'nothing is left to confirm, also for the absent auditor')
    assert.equal((await client.auditCredits(absent.address, AUDIT_EPOCH)).auditor, 0n, 'the absent auditor earned nothing')
    assert.equal((await client.auditCredits(fallback.address, AUDIT_EPOCH)).auditor, 1n, 'the confirming audit is credited')
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a model nobody took by three quarters goes to the second stand-in, and its own auditor\'s late audit still counts', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-second-stand-in-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const wallets = [AUDITOR_PRIVATE_KEY, SECOND_AUDITOR_PRIVATE_KEY, UNAPPROVED_PRIVATE_KEY].map((key) => new Wallet(`0x${key}`))
    const late = wallets[2]!
    const chain = deployAuditChain(rpcUrl, wallets, 1)
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3']
    const rotation = { auditors: wallets.map((wallet) => wallet.address), epoch: AUDIT_EPOCH, availableModels: models }
    const assigned = (auditor: Wallet) => roundRobinAssignmentFor(auditor.address, rotation).models
    const lateModel = assigned(late)[0]!
    const [, firstAddress, secondAddress] = auditorRotationForModel(lateModel, rotation)
    const first = wallets.find((wallet) => wallet.address === firstAddress)!
    const second = wallets.find((wallet) => wallet.address === secondAddress)!

    const seller = randomWallet()
    const audit = (model: string): FixtureAudit => ({
      agentId: '1', seller, model, service: model, verdict: 'SAME', reference: referenceFixture(model),
    })
    const dirs = {
      first: await auditorDataDir(directory, 'first', first, chain.crypto, models),
      second: await auditorDataDir(directory, 'second', second, chain.crypto, models),
      late: await auditorDataDir(directory, 'late', late, chain.crypto, models),
    }
    const submit = (who: keyof typeof dirs, runId: string) => runCli(dirs[who].dataDir, dirs[who].configPath, rpcUrl, [
      'submit', '--run-id', runId, '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    interface AssignmentJson {
      epochs: Array<{ epoch: string; handovers: Array<{ model: string; assignedAuditor: string; standIn: string; stage: number }> }>
    }
    // What `verifier assignment` shows each auditor: all three must see the same stand-in.
    const handoversShown = () => (Object.keys(dirs) as Array<keyof typeof dirs>).map((who) => {
      const result = runCli(dirs[who].dataDir, dirs[who].configPath, null, ['assignment', '--json'])
      assert.equal(result.status, 0, result.output)
      return (JSON.parse(result.stdout) as AssignmentJson).epochs[0]!.handovers
    })
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const handoversFor = async (auditor: Wallet) => handoverModelsFor(auditor.address, {
      ...rotation,
      audits: await loadEpochModelAudits({ reader: client, epoch: AUDIT_EPOCH, epochStartedAt, deploymentBlock: 0 }),
      epochStartedAt,
      epochEndsAt: epochStartedAt + EPOCH_DURATION,
      now: await chainNow(client.provider),
    })

    // Both active auditors audit their own model early in the epoch.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    for (const who of ['first', 'second'] as const) {
      await dirs[who].writeRun(`${who}-own`, [audit(assigned(who === 'first' ? first : second)[0]!)])
      const result = submit(who, `${who}-own`)
      assert.equal(result.status, 0, result.output)
    }

    // Halfway: the late auditor's model goes to the first stand-in, who does not take it.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 2])
    await rpc(rpcUrl, 'evm_mine', [])
    const stageOne = [{ model: lateModel, assignedAuditor: late.address, standIn: first.address, stage: 1 }]
    assert.deepEqual(handoversShown(), [stageOne, stageOne, stageOne])
    assert.deepEqual(await handoversFor(second), [], 'the second stand-in waits')

    // Three quarters: it moves on to the second stand-in, for every auditor at the same block.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 4])
    await rpc(rpcUrl, 'evm_mine', [])
    const now = await chainNow(client.provider)
    assert.ok(now >= epochStartedAt + EPOCH_DURATION * 0.75 && now < epochStartedAt + EPOCH_DURATION, `chain time ${now} is in the last quarter`)
    const stageTwo = [{ model: lateModel, assignedAuditor: late.address, standIn: second.address, stage: 2 }]
    assert.deepEqual(handoversShown(), [stageTwo, stageTwo, stageTwo])
    assert.deepEqual(await handoversFor(first), [], 'the first stand-in is no longer asked')
    assert.deepEqual(await handoversFor(second), stageTwo)

    await dirs.second.writeRun('second-handover', [audit(lateModel)])
    const handedOver = submit('second', 'second-handover')
    assert.equal(handedOver.status, 0, handedOver.output)
    assert.deepEqual(await client.auditCredits(second.address, AUDIT_EPOCH), { auditor: 2n, total: 3n })
    assert.deepEqual(handoversShown(), [[], [], []], 'once audited, the model is no longer handed over')

    // The model's own auditor comes back in the last quarter: the contract takes and credits its audit too.
    await dirs.late.writeRun('late-own', [audit(lateModel)])
    const lateRun = submit('late', 'late-own')
    assert.equal(lateRun.status, 0, lateRun.output)
    assert.deepEqual(await client.auditCredits(late.address, AUDIT_EPOCH), { auditor: 1n, total: 4n })
    assert.deepEqual(await client.auditCredits(second.address, AUDIT_EPOCH), { auditor: 2n, total: 4n }, 'the stand-in keeps its credit')
    const events = await client.queryModelAudits({ model: modelHash(lateModel) }, 0)
    assert.deepEqual(events.map((event) => event.auditor), [second.address, late.address])
    assert.deepEqual(handoversShown(), [[], [], []])
    assert.equal(await client.isVerified(1n), true)
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * Deploys the audits contracts in `AUDIT_EPOCH` on a local chain, approves `auditors` (before the
 * epoch starts when the chain was started before it) and registers seller agents 1..`sellerAgents`.
 */
function deployAuditChain(rpcUrl: string, auditors: readonly Wallet[], sellerAgents: number) {
  const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
  const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
  const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
  const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
  castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
  castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
  const { resultsAddress, kbfAddress: verificationAddress } = deployVerification(rpcUrl, gateAddress, poolsAddress, identityRegistryAddress)
  castSend(rpcUrl, resultsAddress, 'setRewardsStartEpoch(address,uint64)', [verificationAddress, '0'])
  castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
  castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(GENESIS), String(EPOCH_DURATION)])
  for (const auditor of auditors) {
    castSend(rpcUrl, verificationAddress, 'setAuditor(address,bool)', [auditor.address, 'true'])
  }
  for (let agent = 1; agent <= sellerAgents; agent += 1) {
    castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(agent), SELLER_OWNERS[agent - 1]!])
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', [String(agent), String(AUDIT_EPOCH), '100'])
  }
  const crypto = {
    chainId: 'base-local',
    rpcUrl,
    verificationContractAddress: verificationAddress,
    verificationDeployBlock: 0,
    identityRegistryAddress,
  }
  return { verificationAddress, crypto }
}

/** One auditor's data directory and config on the local chain, auditing `models`. */
async function auditorDataDir(directory: string, name: string, wallet: Wallet, crypto: object, models: readonly string[]) {
  const dataDir = join(directory, name)
  const evidenceDir = join(dataDir, 'verifier', 'evidence')
  const banksDir = join(dataDir, 'verifier', 'banks')
  const configPath = join(dataDir, 'config.json')
  await mkdir(dataDir, { recursive: true })
  await writeFile(join(dataDir, 'identity.key'), `${wallet.privateKey.slice(2)}\n`, { mode: 0o600 })
  await writeFile(configPath, JSON.stringify({
    payments: { preferredMethod: 'crypto', crypto },
    verifier: { evidenceDir, banksDir, auditor: wallet.address, testModels: models, ...FIXTURE_CONFIG },
  }))
  const writeRun = (runId: string, audits: FixtureAudit[]) => (
    writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor: wallet, audits })
  )
  return { dataDir, configPath, writeRun }
}

function runCli(
  dataDir: string,
  configPath: string,
  /** `--rpc-url` for commands that take it; null for those that read `payments.crypto.rpcUrl`. */
  rpcUrl: string | null,
  args: string[],
  options: RunCliOptions = {},
): CommandResult {
  const result = spawnSync(process.execPath, [
    ...(options.importPath ? ['--import', options.importPath] : []),
    cliEntry,
    '--data-dir', dataDir,
    '--config', configPath,
    'verifier',
    ...args,
    ...(rpcUrl ? ['--rpc-url', rpcUrl] : []),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    stdout: result.stdout ?? '',
  }
}

async function rpc(rpcUrl: string, method: string, params: unknown[] = []): Promise<unknown> {
  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = await response.json() as { result?: unknown; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)
  return body.result
}

async function writeMockPinataPreload(path: string, logPath: string): Promise<void> {
  await writeFile(path, `
import { appendFileSync } from 'node:fs'

const originalFetch = globalThis.fetch
const logPath = ${JSON.stringify(logPath)}

globalThis.fetch = async (input, init) => {
  if (String(input) !== 'https://uploads.pinata.cloud/v3/files') {
    return originalFetch(input, init)
  }
  const form = init.body
  const metadata = JSON.parse(String(form.get('keyvalues')))
  appendFileSync(logPath, JSON.stringify({
    model: metadata.model,
    evidenceHash: metadata.evidenceHash,
    files: form.getAll('file').map((file) => file.name),
  }) + '\\n')
  return new Response(JSON.stringify({
    data: {
      cid: 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghp' + (metadata.model === 'model-a' ? 'm' : 'n'),
      size: form.getAll('file').reduce((total, file) => total + file.size, 0),
      created_at: '2026-10-07T12:00:00.000Z',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
`)
}

function requireCommand(command: string): void {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`required command not found: ${command}`)
}

/** The verification contracts as M003 wires them: the results layer and the KBF audit at the whole bucket. */
function deployVerification(rpcUrl: string, gateAddress: string, poolsAddress: string, identityRegistryAddress: string) {
  const resultsAddress = deployContract(
    rpcUrl,
    'verification/AntseedVerificationResults.sol:AntseedVerificationResults',
    [gateAddress],
  )
  const kbfAddress = deployContract(
    rpcUrl,
    'verification/AntseedKbfAudits.sol:AntseedKbfAudits',
    [resultsAddress, poolsAddress, identityRegistryAddress],
  )
  castSend(rpcUrl, resultsAddress, 'setAudit(address,bool)', [kbfAddress, 'true'])
  castSend(rpcUrl, resultsAddress, 'setAuditShareBps(address,uint16)', [kbfAddress, '10000'])
  return { resultsAddress, kbfAddress }
}

function deployContract(rpcUrl: string, contract: string, constructorArgs: string[] = []): string {
  const output = runCommand('forge', [
    'create',
    contract,
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    '--broadcast',
    ...(constructorArgs.length > 0 ? ['--constructor-args', ...constructorArgs] : []),
  ], contractsDirectory)
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`could not parse deployed address for ${contract}:\n${output}`)
  return match[1]!
}

function castSend(rpcUrl: string, contract: string, signature: string, args: string[]): void {
  runCommand('cast', [
    'send',
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    contract,
    signature,
    ...args,
  ], repoRoot)
}

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}\n${output || '(no output)'}`)
  }
  return output
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate an Anvil port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

function startAnvil(port: number, options: { timestamp?: number } = {}): ChildProcessWithoutNullStreams {
  return spawn('anvil', [
    '--host', '127.0.0.1', '--port', String(port), '--silent',
    ...(options.timestamp !== undefined ? ['--timestamp', String(options.timestamp)] : []),
  ], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
}

async function waitForRpcReady(
  rpcUrl: string,
  anvil: ChildProcessWithoutNullStreams,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) throw new Error(`Anvil exited before RPC startup with code ${anvil.exitCode}`)
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) return
    } catch {
      // Retry until the deadline.
    }
    await sleep(100)
  }
  throw new Error(`Anvil RPC did not start within ${timeoutMs}ms`)
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

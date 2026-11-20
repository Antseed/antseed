import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { createServer as createHttpServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dryRunPreparedPath } from './epoch-submission-record.js'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { Interface, Wallet, getAddress, hexlify, randomBytes } from 'ethers'
import { VerificationStorage } from '@antseed/node'
import { VERIFIER_VERDICT, VerifierClient, modelHash, serviceHash, sortServiceResults } from '@antseed/node/payments'
import {
  FIXTURE_CONFIG,
  freshReferenceFixture,
  peerIdOf,
  referenceFixture,
  writeCalibratedEpochSet,
  writeSignedAuditRun,
  type FixtureAudit,
} from './model-audit-fixtures.test-support.js'
import { NO_EPOCH_QUESTION_SET, epochQuestionSetPath, reserveModelAuditReference } from './probe-bank.js'
import {
  CONFIRMATION_WINDOW_SECONDS, loadBlockTimestamps, loadEpochReports, pendingConfirmations, waitingReportBlocks,
} from './pending-confirmations.js'
import { roundRobinAssignmentFor, auditorRotationForModel } from './audit-assignment.js'
import { handoverModelsFor, loadEpochModelAudits } from './audit-handover.js'
import { chainNow } from './chain-clock.js'
import { openAuditWindow, readAuditWindow, windowIncludesSeller } from './audit-window.js'
import { modelAuditEvidencePath } from './model-audit.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const AUDITOR_PRIVATE_KEY = '8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba'
const UNAPPROVED_PRIVATE_KEY = '92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e'
const SECOND_AUDITOR_PRIVATE_KEY = '4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356'
/** Anvil's funded test accounts 8 and 9, for tests with five auditors. */
const FOURTH_AUDITOR_PRIVATE_KEY = 'dbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97'
const FIFTH_AUDITOR_PRIVATE_KEY = '2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6'
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
    // The dry run leaves what it prepared, row by row, with the identity and decision the real preparation uses.
    const preparedPath = dryRunPreparedPath(approved.evidenceDir, EPOCH)
    const prepared = JSON.parse(await readFile(preparedPath, 'utf8')) as {
      format: string; version: number; epoch: string
      rows: Array<{ model: string; agentId: string | null; serviceHash: string; decision: string; reasonCode: string | null; verdict: string | null; auditId: string | null; evidenceHash: string | null }>
    }
    assert.equal(prepared.format, 'antseed-verifier-dry-run-prepared')
    assert.equal(prepared.version, 1)
    assert.equal(prepared.epoch, EPOCH)
    const decided = prepared.rows.map((row) => `${row.model} ${row.agentId} ${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}${row.verdict ? ` ${row.verdict}` : ''}`).sort()
    assert.deepEqual(decided, [
      'model-a 1 send SAME', 'model-a 2 send DIFF', 'model-b 1 send SAME', 'model-b 2 send UNDETERMINED', 'model-b 3 excluded self-audit SAME',
    ])
    assert.ok(prepared.rows.every((row) => row.serviceHash === serviceHash(row.model) && row.auditId && row.evidenceHash))
    // A real submit never writes it: the dry run's file is set aside, and the submits below leave none.
    await rm(preparedPath)

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
    assert.equal(existsSync(preparedPath), false, 'a real submit writes no dry-run file')

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
  const ipfs = await mockIpfs(directory)
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  // The chain starts two minutes before the epoch, so the auditors are approved when it starts: the
  // rotation, and so who confirms whom, uses the auditors approved at the epoch's start.
  const anvil = startAnvil(port, { timestamp: GENESIS + AUDIT_EPOCH * EPOCH_DURATION - 120 })
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

    // Seller 1 is honest; seller 2 does not serve either model. A audits claude-opus-5.5 and B gemini-4-argon:
    // audited models, since only those have confirmers (a DIFF on another model waits for nobody).
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
      const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor, audits, ...(completedAt ? { completedAt } : {}) })
      )
      return { dataDir, configPath, writeRun }
    }
    const a = await setUpDataDir('auditor-a', AUDITOR_PRIVATE_KEY)
    const b = await setUpDataDir('auditor-b', SECOND_AUDITOR_PRIVATE_KEY)
    const submit = (dirs: typeof a, runId: string) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', runId, '--yes', '--skip-version-check',
    ], ipfs.options)
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
    const pendingFor = async (auditor: string) => pendingConfirmations({
      reports: await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: 0 }),
      epoch: AUDIT_EPOCH,
      now: epochStartedAt + 60,
      auditor,
      auditors: [auditorA.address, auditorB.address],
      auditedModels: ['claude-opus-5.5', 'gemini-4-argon'],
    }).map((entry) => ({
      model: entry.model, agentId: entry.agentId, waiting: entry.waiting, confirmer: entry.confirmer, mine: entry.mine,
    }))

    assert.deepEqual(await client.requiredReports(), { SAME: 1, DIFF: 2, UNDETERMINED: 1 })
    // Into the epoch, so every report below is in the epoch's blocks.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])

    await a.writeRun('a-claude-opus-5.5', [audit(1, 'claude-opus-5.5'), audit(2, 'claude-opus-5.5')])
    await b.writeRun('b-gemini-4-argon', [audit(1, 'gemini-4-argon'), audit(2, 'gemini-4-argon')])
    const reportedA = submit(a, 'a-claude-opus-5.5')
    assert.equal(reportedA.status, 0, reportedA.output)
    assert.match(reportedA.output, /claude-opus-5.5: 1 recorded, 1 waiting for another auditor/)
    assert.match(reportedA.output, /agent 2: DIFF 1\/2/)
    const reportedB = submit(b, 'b-gemini-4-argon')
    assert.equal(reportedB.status, 0, reportedB.output)
    assert.match(reportedB.output, /gemini-4-argon: 1 recorded, 1 waiting for another auditor/)
    assert.equal(await client.isVerified(1n), true, 'one SAME verifies')
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'one DIFF is only a report')

    // Each auditor is the confirmer of the other's DIFF.
    const waitingDiff = [{ verdict: 'DIFF', reports: 1, required: 2 }]
    assert.deepEqual(await pendingFor(auditorA.address), [
      { model: 'claude-opus-5.5', agentId: 2n, waiting: waitingDiff, confirmer: auditorB.address, mine: false },
      { model: 'gemini-4-argon', agentId: 2n, waiting: waitingDiff, confirmer: auditorA.address, mine: true },
    ])
    assert.deepEqual((await pendingFor(auditorB.address)).map((entry) => [entry.model, entry.mine]), [
      ['claude-opus-5.5', true], ['gemini-4-argon', false],
    ])

    // Each confirms with its own audit of the other's model.
    await a.writeRun('a-confirm-gemini-4-argon', [audit(2, 'gemini-4-argon')], await confirmationTime(client.provider))
    await b.writeRun('b-confirm-claude-opus-5.5', [audit(2, 'claude-opus-5.5')], await confirmationTime(client.provider))
    const confirmedByB = submit(b, 'b-confirm-claude-opus-5.5')
    assert.equal(confirmedByB.status, 0, confirmedByB.output)
    assert.match(confirmedByB.output, /claude-opus-5.5: 1 recorded, 0 waiting for another auditor/)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })
    const confirmedByA = submit(a, 'a-confirm-gemini-4-argon')
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

test('a tokenizer pre-check DIFF is one auditor\'s report until another auditor\'s own pre-check confirms it, and its evidence says why', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-tokenizer-e2e-'))
  const ipfs = await mockIpfs(directory)
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  // The chain starts two minutes before the epoch, so both auditors are approved when it starts.
  const anvil = startAnvil(port, { timestamp: GENESIS + AUDIT_EPOCH * EPOCH_DURATION - 120 })
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

    // Seller 1 serves the model. Seller 2 signs input tokens counted by another tokenizer: each auditor's
    // pre-check finds it, beside its questions. An audited model, since only those have confirmers.
    // Seller 3 is flagged by A's questions and by B's pre-check: two findings, each seen once, so no DIFF.
    const model = 'claude-opus-5.5'
    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', ['3', randomWallet().address])
    castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', ['3', String(AUDIT_EPOCH), '100'])
    const reference = referenceFixture(model)
    const honest: FixtureAudit = { agentId: '1', seller: sellers[0]!, model, service: model, verdict: 'SAME', reference }
    const miscounting: FixtureAudit = { agentId: '2', seller: sellers[1]!, model, service: model, verdict: 'DIFF', tokenizerMismatch: true, reference }
    const questioned: FixtureAudit = { agentId: '3', seller: sellers[2]!, model, service: model, verdict: 'DIFF', reference }
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
      const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor, audits, ...(completedAt ? { completedAt } : {}) })
      )
      return { dataDir, configPath, evidenceDir, writeRun }
    }
    const a = await setUpDataDir('auditor-a', AUDITOR_PRIVATE_KEY)
    const b = await setUpDataDir('auditor-b', SECOND_AUDITOR_PRIVATE_KEY)
    const submit = (dirs: typeof a, runId: string) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', runId, '--yes', '--skip-version-check',
    ], ipfs.options)
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    // Into the epoch, so every report below is in the epoch's blocks.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])

    await a.writeRun('a-audit', [honest, miscounting, questioned])
    const reported = submit(a, 'a-audit')
    assert.equal(reported.status, 0, reported.output)
    assert.match(reported.output, /claude-opus-5.5: 1 recorded, 2 waiting for another auditor/)
    assert.match(reported.output, /agent 2: DIFF 1\/2/)
    assert.equal(await client.isVerified(1n), true, 'the honest seller is verified on its questions')
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'a pre-check DIFF is one auditor\'s report, like any DIFF')

    // What the auditor submitted: the DIFF with its reason, and the seller's evidence with the signed responses.
    const evidence = JSON.parse(await readFile(modelAuditEvidencePath(a.evidenceDir, 'a-audit', model), 'utf8')) as {
      results: Array<{ agentId: string; verdict: string; verdictReason: string | null; audit: { evidencePath: string } }>
    }
    const diff = evidence.results.find((result) => result.agentId === '2')!
    assert.equal(diff.verdict, 'DIFF')
    assert.match(diff.verdictReason!, /^tokenizer pre-check \(tokenizer-precheck-v3\): the seller signed .* off by more than 0 in every round, while 2 of the model's other sellers signed the model's count$/)
    const sellerEvidence = JSON.parse(await readFile(
      resolve(dirname(modelAuditEvidencePath(a.evidenceDir, 'a-audit', model)), diff.audit.evidencePath), 'utf8',
    )) as { exchanges: unknown[]; tokenizerPrecheck: { outcome: string; rounds: Array<{ seller: Array<{ delta: number }>; reference: { delta: number } }> } }
    assert.ok(sellerEvidence.exchanges.length > 0, 'every test runs: its questions were asked beside the mismatch')
    assert.equal(sellerEvidence.tokenizerPrecheck.outcome, 'mismatch')
    assert.equal(sellerEvidence.tokenizerPrecheck.rounds.length, 3)
    for (const round of sellerEvidence.tokenizerPrecheck.rounds) {
      // Asked twice, the same count both times, and not the model's.
      assert.equal(round.seller.length, 2)
      assert.equal(round.seller[0]!.delta, round.seller[1]!.delta)
      assert.ok(Math.abs(round.seller[0]!.delta - round.reference.delta) > 2)
    }

    // The other auditor confirms with its own pre-check, on its own probes, and the contract records the DIFF.
    // Its pre-check also flags seller 3, whose waiting DIFF came from A's questions: another check, so nothing
    // is sent for it. The seller keeps its record and A's DIFF stays one report.
    await b.writeRun('b-confirm', [miscounting, { ...questioned, tokenizerMismatch: true }], await confirmationTime(client.provider))
    const confirmed = submit(b, 'b-confirm')
    assert.equal(confirmed.status, 0, confirmed.output)
    assert.match(confirmed.output, /a DIFF is confirmed only by the same check, so nothing is sent and the seller keeps its record/)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })
    assert.deepEqual(await client.agentStatus(3n), { verifiedCount: 0, diffCount: 0 }, 'a DIFF by another check is no confirmation')
    const thirdReports = await client.queryServiceAudits(3n, null, 0)
    assert.deepEqual(thirdReports.map(({ auditor, verdict, reports, required }) => [auditor, verdict, reports, required]), [
      [auditorA.address, VERIFIER_VERDICT.DIFF, 1, 2],
    ], 'B sent nothing for seller 3')
    const confirmerEvidence = JSON.parse(await readFile(modelAuditEvidencePath(b.evidenceDir, 'b-confirm', model), 'utf8')) as {
      results: Array<{ agentId: string; flaggedBy?: string[]; confirmation?: { firstChecks: string[]; ownChecks: string[]; sameCheck: string | null } }>
      excluded: Array<{ agentId: string | null; reason: string }>
    }
    assert.deepEqual(confirmerEvidence.results.map((result) => [result.agentId, result.flaggedBy, result.confirmation?.firstChecks, result.confirmation?.sameCheck]), [
      ['2', ['tokens'], ['tokens'], 'tokens'],
    ])
    assert.equal(await client.isVerified(2n), false)
    assert.equal(await client.isVerified(1n), true)
    const events = await client.queryServiceAudits(2n, null, 0)
    assert.deepEqual(events.map(({ auditor, reports, required }) => [auditor, reports, required]), [
      [auditorA.address, 1, 2], [auditorB.address, 2, 2],
    ])
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('an audit window submits its sellers together once it closes; a late seller gets no record; another auditor confirms the DIFF', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-window-e2e-'))
  const ipfs = await mockIpfs(directory)
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  // Approved before the epoch starts, as in the tests above: the confirmer comes from the epoch-start rotation.
  const anvil = startAnvil(port, { timestamp: GENESIS + AUDIT_EPOCH * EPOCH_DURATION - 120 })
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
    const owners = [...SELLER_OWNERS, '0x90F79bf6EB2c4f870365E785982E1f101E93b906']
    for (const [index, owner] of owners.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
      castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', [String(index + 1), String(AUDIT_EPOCH), '100'])
    }

    // Sellers 1 (honest) and 2 (not serving claude-opus-5.5) were online when A's claude-opus-5.5 window opened;
    // seller 3 came online later. A manual run audited all three.
    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    const audit = (agent: 1 | 2 | 3, verdict: FixtureAudit['verdict']): FixtureAudit => ({
      agentId: String(agent), seller: sellers[agent - 1]!, model: 'claude-opus-5.5', service: 'claude-opus-5.5', verdict,
      reference: referenceFixture('claude-opus-5.5'),
    })
    const crypto = {
      chainId: 'base-local', rpcUrl, verificationContractAddress: verificationAddress, verificationDeployBlock: 0, identityRegistryAddress,
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
      const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor, audits, ...(completedAt ? { completedAt } : {}) })
      )
      return { dataDir, configPath, evidenceDir, writeRun }
    }
    const a = await setUpDataDir('auditor-a', AUDITOR_PRIVATE_KEY)
    const b = await setUpDataDir('auditor-b', SECOND_AUDITOR_PRIVATE_KEY)
    const submit = (dirs: typeof a) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--yes', '--skip-version-check',
    ], ipfs.options)
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    // Into the epoch, so every report below is in the epoch's blocks.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])

    await a.writeRun('a-claude-opus-5.5', [audit(1, 'SAME'), audit(2, 'DIFF'), audit(3, 'SAME')])
    await openAuditWindow({
      evidenceDir: a.evidenceDir, epoch: EPOCH, model: 'claude-opus-5.5', runId: 'a-claude-opus-5.5',
      sellers: [sellers[0]!, sellers[1]!].map((seller) => seller.address.slice(2)),
    })
    // While the window is open nothing of claude-opus-5.5 is published or submitted (a dry run closes nothing).
    const whileOpen = runCli(a.dataDir, a.configPath, rpcUrl, ['submit', '--no-publish-ipfs', '--dry-run', '--skip-version-check'])
    assert.equal(whileOpen.status, 0, whileOpen.output)
    assert.match(whileOpen.output, /audit window is still open/)
    assert.equal((await client.queryModelAudits()).length, 0)

    // The real submit closes the finished window and sends its two sellers in one audit.
    const reportedA = submit(a)
    assert.equal(reportedA.status, 0, reportedA.output)
    assert.match(reportedA.output, /claude-opus-5.5: audit window closed \(every seller of the window is finished\)/)
    assert.match(reportedA.output, /claude-opus-5.5: 1 recorded, 1 waiting for another auditor/)
    assert.equal((await client.queryModelAudits()).length, 1)
    assert.equal(await client.isVerified(1n), true)
    assert.equal((await client.serviceStatus(3n, 'claude-opus-5.5')).verdict, VERIFIER_VERDICT.NONE, 'the late seller has no record')
    assert.equal((await client.queryServiceAudits(3n)).length, 0)

    // B has no window for claude-opus-5.5: its confirmation of seller 2's DIFF is submitted at once.
    await b.writeRun('b-confirm-claude-opus-5.5', [audit(2, 'DIFF')], await confirmationTime(client.provider))
    const confirmedByB = submit(b)
    assert.equal(confirmedByB.status, 0, confirmedByB.output)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('a confirmation\'s upload retires the question set it publishes; the next confirmation of the model gets new questions', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-retire-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port, { timestamp: GENESIS + AUDIT_EPOCH * EPOCH_DURATION - 120 })
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
    for (const [index, owner] of [...SELLER_OWNERS, randomWallet().address].entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), owner])
      castSend(rpcUrl, poolsAddress, 'setPower(uint256,uint256,uint256)', [String(index + 1), String(AUDIT_EPOCH), '100'])
    }
    const model = 'claude-opus-5.5'
    // Sellers 2 and 3 both get a DIFF from A, and B is the model's confirmer.
    const sellers = [randomWallet(), randomWallet(), randomWallet()]
    const diff = (agent: 1 | 2 | 3, reference = referenceFixture(model)): FixtureAudit => ({
      agentId: String(agent), seller: sellers[agent - 1]!, model, service: model, verdict: 'DIFF', reference,
    })
    const crypto = {
      chainId: 'base-local', rpcUrl, verificationContractAddress: verificationAddress, verificationDeployBlock: 0, identityRegistryAddress,
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
      const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor, audits, ...(completedAt ? { completedAt } : {}) })
      )
      return { dataDir, configPath, banksDir, evidenceDir, writeRun }
    }
    const a = await setUpDataDir('auditor-a', AUDITOR_PRIVATE_KEY)
    const b = await setUpDataDir('auditor-b', SECOND_AUDITOR_PRIVATE_KEY)
    const pinataLogPath = join(directory, 'pinata-uploads.jsonl')
    const pinataPreloadPath = join(directory, 'mock-pinata.mjs')
    await writeMockPinataPreload(pinataPreloadPath, pinataLogPath, join(directory, 'ipfs-store'))
    const submit = (dirs: typeof a, runId: string, extra: string[]) => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', runId, '--skip-version-check', ...extra,
    ], { importPath: pinataPreloadPath, env: { PINATA_JWT: 'test-pinata-jwt' } })
    const client = new VerifierClient({ rpcUrl, contractAddress: verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const setPath = epochQuestionSetPath(b.banksDir, model, EPOCH)
    const retiredPath = (index: number) => join(dirname(setPath), `set.published-${index}.json`)
    const exists = (path: string) => readFile(path).then(() => true, () => false)
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])

    const uploads = async () => (await readFile(pinataLogPath, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).length
    // A publishes its DIFFs: B reads there which check flagged them before it confirms one (same-check.ts).
    await a.writeRun('a-reports', [diff(1), diff(2), diff(3)])
    const reported = submit(a, 'a-reports', ['--yes'])
    assert.equal(reported.status, 0, reported.output)
    assert.match(reported.output, /claude-opus-5.5: 0 recorded, 3 waiting for another auditor/)
    const reportUploads = await uploads()

    // B confirms seller 2 on its epoch set, outside any audit window (confirmations are never windowed).
    const first = await writeCalibratedEpochSet({ banksDir: b.banksDir, model, epoch: EPOCH, reference: referenceFixture(model, 300) })
    await b.writeRun('b-confirm-2', [diff(2, first.reference)], await confirmationTime(client.provider))
    const dryRun = submit(b, 'b-confirm-2', ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.equal(await exists(setPath), true, 'a dry run retires nothing')
    assert.equal(await exists(retiredPath(1)), false)
    /** B's uploads: every upload after A's report. */
    const uploadCount = async () => (await uploads()) - reportUploads

    // A `verifier run` of B's data dir is going on (a live process holds its run lock): nothing of the model is published.
    const runLockPath = join(b.evidenceDir, '.run.lock')
    await writeFile(runLockPath, JSON.stringify({ pid: process.pid, token: 'test-run', createdAt: new Date().toISOString() }))
    const duringRun = submit(b, 'b-confirm-2', ['--yes'])
    assert.equal(duringRun.status, 0, duringRun.output)
    assert.match(duringRun.output, /a `verifier run` is in progress, so nothing of claude-opus-5\.5 is published now/)
    assert.match(duringRun.output, /held while a run is in progress: 1/)
    assert.equal(await uploadCount(), 0, 'nothing uploaded')
    assert.equal(await exists(setPath), true, 'nothing retired')
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 0 }, 'no transaction')
    await rm(runLockPath)

    // The upload fails after the retire: the set is retired anyway, since it may have reached Pinata.
    await writeFile(`${pinataLogPath}.fail`, '')
    const failedUpload = submit(b, 'b-confirm-2', ['--yes'])
    assert.equal(failedUpload.status, 1, failedUpload.output)
    assert.equal(await exists(setPath), false)
    assert.equal(await exists(retiredPath(1)), true)
    await rm(`${pinataLogPath}.fail`)
    // The next run builds a new set (for other work on the model); the next submit sends the stored
    // evidence again, which has nothing of the new set in it: the new set stays in use.
    const rebuilt = await writeCalibratedEpochSet({ banksDir: b.banksDir, model, epoch: EPOCH, reference: freshReferenceFixture(model, 'rebuilt', 300) })
    const confirmed2 = submit(b, 'b-confirm-2', ['--yes'])
    assert.equal(confirmed2.status, 0, confirmed2.output)
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })
    assert.equal(await uploadCount(), 1)
    assert.equal(JSON.parse(await readFile(setPath, 'utf8')).reference.referenceId, rebuilt.reference.referenceId, 'the new set is not retired')
    assert.equal(await exists(retiredPath(2)), false)
    assert.doesNotMatch(confirmed2.output, /questions are published with it/)
    // The first set is the one the upload published: no seller is reserved on it any more.
    const retired = JSON.parse(await readFile(retiredPath(1), 'utf8')) as { reference: { referenceId: string }; retired?: { runId: string } }
    assert.equal(retired.reference.referenceId, first.reference.referenceId)
    assert.equal(retired.retired?.runId, 'b-confirm-2')
    assert.match(failedUpload.output, /its epoch 5 questions are published with it/)

    // Seller 3 is confirmed on the new set and gets none of the published questions.
    const second = rebuilt
    const reserved = await reserveModelAuditReference({
      banksDir: b.banksDir, model, sellerPeerId: sellers[2]!.address.slice(2).toLowerCase(), service: model, runId: 'b-run-3', epoch: EPOCH,
      config: FIXTURE_CONFIG,
    })
    assert.equal(reserved.reference.referenceId, second.reference.referenceId)
    const published = [first.reference, ...first.extensions].flatMap((reference) => reference.probes)
    const publishedIds = new Set(published.map((probe) => probe.id))
    assert.equal(reserved.reference.probes.some((probe) => publishedIds.has(probe.id)), false)
    await b.writeRun('b-confirm-3', [diff(3, second.reference)], await confirmationTime(client.provider))
    const confirmed3 = submit(b, 'b-confirm-3', ['--yes'])
    assert.equal(confirmed3.status, 0, confirmed3.output)
    assert.deepEqual(await client.agentStatus(3n), { verifiedCount: 0, diffCount: 1 })
    assert.equal(await exists(retiredPath(2)), true, 'the upload of the new set retires it')
    await assert.rejects(reserveModelAuditReference({
      banksDir: b.banksDir, model, sellerPeerId: sellers[0]!.address.slice(2).toLowerCase(), service: model, runId: 'b-run-4', epoch: EPOCH,
      config: FIXTURE_CONFIG,
    }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
    assert.equal(await uploadCount(), 2)

    // B confirms seller 1 on a third set. The chain moves to the next epoch after the submit checked the run's
    // epoch and before the upload (a preload sends the epoch change on the submit's next epoch read, in publish):
    // nothing is uploaded or retired, and the model counts as failed.
    const third = await writeCalibratedEpochSet({ banksDir: b.banksDir, model, epoch: EPOCH, reference: freshReferenceFixture(model, 'third', 300) })
    await b.writeRun('b-confirm-1', [diff(1, third.reference)], await confirmationTime(client.provider))
    const movePreloadPath = join(directory, 'move-epoch.mjs')
    await writeFile(movePreloadPath, `
import ${JSON.stringify(pathToFileURL(pinataPreloadPath).href)}
const { VerifierClient } = await import(${JSON.stringify(import.meta.resolve('@antseed/node/payments'))})
const original = VerifierClient.prototype.currentEpochWindow
let calls = 0
VerifierClient.prototype.currentEpochWindow = async function (...args) {
  calls += 1
  if (calls === 2) {
    const response = await fetch(${JSON.stringify(rpcUrl)}, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendTransaction', params: [{
        from: ${JSON.stringify(new Wallet(`0x${DEPLOYER_PRIVATE_KEY}`).address)}, to: ${JSON.stringify(gateAddress)},
        data: ${JSON.stringify(new Interface(['function setCurrentEpoch(uint256)']).encodeFunctionData('setCurrentEpoch', [AUDIT_EPOCH + 1]))},
      }] }),
    })
    const reply = await response.json()
    if (reply.error) throw new Error('could not move the epoch: ' + reply.error.message)
  }
  return original.apply(this, args)
}
`)
    const lateUpload = runCli(b.dataDir, b.configPath, rpcUrl, ['submit', '--run-id', 'b-confirm-1', '--skip-version-check', '--yes'],
      { importPath: movePreloadPath, env: { PINATA_JWT: 'test-pinata-jwt' } })
    assert.equal(lateUpload.status, 1, lateUpload.output)
    assert.match(lateUpload.output, /the chain is in epoch 6 now, so nothing of claude-opus-5\.5 from epoch 5 is published/)
    assert.equal(await uploadCount(), 2, 'nothing uploaded')
    assert.equal(JSON.parse(await readFile(setPath, 'utf8')).reference.referenceId, third.reference.referenceId, 'nothing retired')
    assert.equal(await exists(retiredPath(3)), false)
    castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
    assert.deepEqual(await client.agentStatus(1n), { verifiedCount: 0, diffCount: 0 }, 'no transaction')
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
      const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
        writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor: wallet, audits, ...(completedAt ? { completedAt } : {}) })
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
    const expected = [{ model: lazyModel, assignedAuditor: wallets.lazy.address, standIn: standIn.address, stage: 1, revoked: false }]
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
  const ipfs = await mockIpfs(directory)
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
      'submit', '--run-id', runId, '--yes', '--skip-version-check',
    ], ipfs.options)
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    // What `verifier run` works out for each auditor, on the chain's clock.
    const pendingFor = async (auditor: Wallet) => {
      const reports = await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: 0 })
      return pendingConfirmations({
        reports,
        epoch: AUDIT_EPOCH,
        blockTimestamps: await loadBlockTimestamps(
          { getBlock: (block) => client.provider.getBlock(block) }, waitingReportBlocks(reports),
        ),
        now: await chainNow(client.provider),
        auditor: auditor.address,
        auditors: rotation.auditors,
        auditedModels: models,
      }).map((entry) => ({
        model: entry.model, agentId: entry.agentId, waiting: entry.waiting, confirmer: entry.confirmer, mine: entry.mine,
      }))
    }
    const waiting = (mine: boolean, confirmer: Wallet = absent) => [{
      model, agentId: 1n, waiting: [{ verdict: 'DIFF', reports: 1, required: 2 }], confirmer: confirmer.address, mine,
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
    assert.deepEqual(await pendingFor(fallback), waiting(false), 'during the confirmer\'s turn the third auditor leaves it alone')
    assert.deepEqual(await pendingFor(reporter), waiting(false))

    // The confirmer's 12 hours pass without an answer: the third auditor takes it.
    await rpc(rpcUrl, 'evm_increaseTime', [CONFIRMATION_WINDOW_SECONDS])
    await rpc(rpcUrl, 'evm_mine', [])
    assert.deepEqual(await pendingFor(fallback), waiting(true, fallback))
    assert.deepEqual(await pendingFor(absent), waiting(false, fallback), 'the absent auditor\'s turn is over')
    assert.deepEqual(await pendingFor(reporter), waiting(false, fallback), 'the reporter never confirms its own DIFF')

    // It audits the seller itself, also finds DIFF, and the contract records the DIFF.
    await dirs.fallback.writeRun('fallback-confirm', [diff], await confirmationTime(client.provider))
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

test('a model nobody took by three quarters goes to the second stand-in, and its own auditor\'s late audit sends nothing', {
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
    const stageOne = [{ model: lateModel, assignedAuditor: late.address, standIn: first.address, stage: 1, revoked: false }]
    assert.deepEqual(handoversShown(), [stageOne, stageOne, stageOne])
    assert.deepEqual(await handoversFor(second), [], 'the second stand-in waits')

    // Three quarters: it moves on to the second stand-in, for every auditor at the same block.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 4])
    await rpc(rpcUrl, 'evm_mine', [])
    const now = await chainNow(client.provider)
    assert.ok(now >= epochStartedAt + EPOCH_DURATION * 0.75 && now < epochStartedAt + EPOCH_DURATION, `chain time ${now} is in the last quarter`)
    const stageTwo = [{ model: lateModel, assignedAuditor: late.address, standIn: second.address, stage: 2, revoked: false }]
    assert.deepEqual(handoversShown(), [stageTwo, stageTwo, stageTwo])
    assert.deepEqual(await handoversFor(first), [], 'the first stand-in is no longer asked')
    assert.deepEqual(await handoversFor(second), stageTwo)

    await dirs.second.writeRun('second-handover', [audit(lateModel)])
    const handedOver = submit('second', 'second-handover')
    assert.equal(handedOver.status, 0, handedOver.output)
    assert.deepEqual(await client.auditCredits(second.address, AUDIT_EPOCH), { auditor: 2n, total: 3n })
    assert.deepEqual(handoversShown(), [[], [], []], 'once audited, the model is no longer handed over')

    // The model's own auditor comes back in the last quarter. The stand-in already judged its sellers,
    // and a seller gets no second opinion on a SAME, so its late audit sends nothing (never a third opinion).
    await dirs.late.writeRun('late-own', [audit(lateModel)])
    const lateRun = submit('late', 'late-own')
    assert.equal(lateRun.status, 0, lateRun.output)
    assert.match(lateRun.output, /already judged this epoch/)
    assert.deepEqual(await client.auditCredits(late.address, AUDIT_EPOCH), { auditor: 0n, total: 3n })
    assert.deepEqual(await client.auditCredits(second.address, AUDIT_EPOCH), { auditor: 2n, total: 3n }, 'the stand-in keeps its credit')
    const events = await client.queryModelAudits({ model: modelHash(lateModel) }, 0)
    assert.deepEqual(events.map((event) => event.auditor), [second.address])
    assert.deepEqual(handoversShown(), [[], [], []])
    assert.equal(await client.isVerified(1n), true)
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('five auditors: a DIFF passes three missed confirmer turns to the fourth, and a model passes its auditor and first stand-in to the second', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-fallback-chain-e2e-'))
  const ipfs = await mockIpfs(directory)
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  // A week-long epoch, as on Base, so four 12-hour confirmer turns fit before halfway.
  const duration = 7 * 86_400
  const epochStartedAt = Date.parse('2026-10-07T00:00:00.000Z') / 1_000
  const schedule = { genesis: epochStartedAt - AUDIT_EPOCH * duration, duration }
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const wallets = [
      AUDITOR_PRIVATE_KEY, SECOND_AUDITOR_PRIVATE_KEY, UNAPPROVED_PRIVATE_KEY, FOURTH_AUDITOR_PRIVATE_KEY, FIFTH_AUDITOR_PRIVATE_KEY,
    ].map((key) => new Wallet(`0x${key}`))
    const chain = deployAuditChain(rpcUrl, wallets, 1, schedule)
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3', 'minimax-m3', 'qwen3.8-27b']
    const rotation = { auditors: wallets.map((wallet) => wallet.address), epoch: AUDIT_EPOCH, availableModels: models }
    const byAddress = (address: string) => wallets.find((wallet) => wallet.address === address)!
    const ownModel = (auditor: Wallet) => roundRobinAssignmentFor(auditor.address, rotation).models[0]!

    // Every model's rotation is the same five auditors, shifted. The DIFF model's is [reporter, c1..c4]:
    // c1..c4 get the confirmer turns in that order. c1 never runs, so its own model's rotation is
    // [c1, c2, c3, c4, reporter]: c2 is its first stand-in and c3 its second.
    const diffModel = models[0]!
    const [reporter, c1, c2, c3, c4] = auditorRotationForModel(diffModel, rotation).map(byAddress) as [Wallet, Wallet, Wallet, Wallet, Wallet]
    const handedOverModel = ownModel(c1)
    assert.deepEqual(auditorRotationForModel(handedOverModel, rotation), [c1, c2, c3, c4, reporter].map((wallet) => wallet.address))
    const names = new Map([[reporter, 'reporter'], [c1, 'c1'], [c2, 'c2'], [c3, 'c3'], [c4, 'c4']] as const)
    const nameOf = (address: string | null) => (address === null ? null : names.get(byAddress(address)) ?? address)

    const seller = randomWallet()
    const audit = (model: string, verdict: FixtureAudit['verdict']): FixtureAudit => ({
      agentId: '1', seller, model, service: model, verdict, reference: referenceFixture(model),
    })
    // c1 never runs, so it has no data directory.
    const dirs = {
      reporter: await auditorDataDir(directory, 'reporter', reporter, chain.crypto, models),
      c2: await auditorDataDir(directory, 'c2', c2, chain.crypto, models),
      c3: await auditorDataDir(directory, 'c3', c3, chain.crypto, models),
      c4: await auditorDataDir(directory, 'c4', c4, chain.crypto, models),
    }
    const running = Object.keys(dirs) as Array<keyof typeof dirs>
    const submit = (who: keyof typeof dirs, runId: string) => runCli(dirs[who].dataDir, dirs[who].configPath, rpcUrl, [
      'submit', '--run-id', runId, '--yes', '--skip-version-check',
    ], ipfs.options)
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const advance = async (seconds: number) => {
      await rpc(rpcUrl, 'evm_increaseTime', [seconds])
      await rpc(rpcUrl, 'evm_mine', [])
    }
    // Whose confirmer turn it is, as every one of the five auditors' `verifier run` works it out.
    const confirmerSeenByAll = async () => {
      const reports = await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: 0 })
      const blockTimestamps = await loadBlockTimestamps({ getBlock: (block) => client.provider.getBlock(block) }, waitingReportBlocks(reports))
      const now = await chainNow(client.provider)
      return wallets.map((auditor) => pendingConfirmations({
        reports, epoch: AUDIT_EPOCH, blockTimestamps, now, auditor: auditor.address, auditors: rotation.auditors, auditedModels: models,
      }).map((entry) => ({ model: entry.model, confirmer: nameOf(entry.confirmer), mine: entry.mine ? nameOf(auditor.address) : null })))
    }
    const turnOf = (confirmer: Wallet) => wallets.map((auditor) => [{
      model: diffModel, confirmer: names.get(confirmer)!, mine: auditor === confirmer ? names.get(confirmer)! : null,
    }])
    interface AssignmentJson {
      epochs: Array<{ handovers: Array<{ model: string; assignedAuditor: string; standIn: string; stage: number }> }>
    }
    // The stand-ins `verifier assignment` shows each running auditor: all of them must agree.
    const handoversShown = () => running.map((who) => {
      const result = runCli(dirs[who].dataDir, dirs[who].configPath, null, ['assignment', '--json'])
      assert.equal(result.status, 0, result.output)
      return (JSON.parse(result.stdout) as AssignmentJson).epochs[0]!.handovers
        .map(({ model, assignedAuditor, standIn, stage }) => ({ model, assigned: nameOf(assignedAuditor), standIn: nameOf(standIn), stage }))
    })
    const standInsFor = async (auditor: Wallet) => handoverModelsFor(auditor.address, {
      ...rotation,
      audits: await loadEpochModelAudits({ reader: client, epoch: AUDIT_EPOCH, epochStartedAt, deploymentBlock: 0 }),
      epochStartedAt,
      epochEndsAt: epochStartedAt + duration,
      now: await chainNow(client.provider),
    })

    // Early in the epoch the four running auditors audit their own model. The reporter finds a DIFF.
    await advance(180)
    for (const who of running) {
      const wallet = who === 'reporter' ? reporter : who === 'c2' ? c2 : who === 'c3' ? c3 : c4
      const model = ownModel(wallet)
      await dirs[who].writeRun(`${who}-own`, [audit(model, model === diffModel ? 'DIFF' : 'SAME')])
      const result = submit(who, `${who}-own`)
      assert.equal(result.status, 0, result.output)
    }
    const reportedAt = await chainNow(client.provider)

    // Confirmation chain. Turn 1 is c1's, which never runs; turns 2 and 3 pass with c2 and c3 down.
    // In each turn every auditor sees the same confirmer, and nobody else is asked.
    assert.deepEqual(await confirmerSeenByAll(), turnOf(c1), 'turn 1: c1')
    await advance(CONFIRMATION_WINDOW_SECONDS)
    assert.deepEqual(await confirmerSeenByAll(), turnOf(c2), 'turn 2: c2')
    await advance(CONFIRMATION_WINDOW_SECONDS)
    assert.deepEqual(await confirmerSeenByAll(), turnOf(c3), 'turn 3: c3')
    await advance(CONFIRMATION_WINDOW_SECONDS)
    assert.deepEqual(await confirmerSeenByAll(), turnOf(c4), 'turn 4: c4')
    assert.ok(await chainNow(client.provider) < epochStartedAt + duration / 2, 'the four turns end before halfway')
    assert.deepEqual(handoversShown(), [[], [], [], []], 'before halfway no model is handed over')

    // c4 audits the seller in its turn, also finds DIFF, and the contract records it.
    await dirs.c4.writeRun('c4-confirm', [audit(diffModel, 'DIFF')], await confirmationTime(client.provider))
    const confirmed = submit('c4', 'c4-confirm')
    assert.equal(confirmed.status, 0, confirmed.output)
    assert.ok(confirmed.output.includes(`${diffModel}: 1 recorded, 0 waiting for another auditor`), confirmed.output)
    const reports = await client.queryServiceAudits(1n, null, 0)
    assert.deepEqual(
      reports.filter((event) => event.modelHash === modelHash(diffModel)).map(({ auditor, reports, required }) => [nameOf(auditor), reports, required]),
      [['reporter', 1, 2], ['c4', 2, 2]],
    )
    assert.ok((await chainNow(client.provider)) - reportedAt < 4 * CONFIRMATION_WINDOW_SECONDS, 'c4 confirmed inside its own turn')
    assert.deepEqual((await client.agentStatus(1n)).diffCount, 1)
    assert.deepEqual(await confirmerSeenByAll(), [[], [], [], [], []], 'nothing is left to confirm')
    assert.equal((await client.auditCredits(c4.address, AUDIT_EPOCH)).auditor, 2n, 'c4: its own model and the confirmation')
    for (const missed of [c1, c2, c3]) {
      assert.equal(
        (await client.auditCredits(missed.address, AUDIT_EPOCH)).auditor,
        missed === c1 ? 0n : 1n,
        `${names.get(missed)} earned nothing for the turn it missed`,
      )
    }

    // Model chain. Halfway: c1's model goes to its first stand-in, c2, which is down and misses it.
    await advance(epochStartedAt + duration / 2 + 60 - await chainNow(client.provider))
    const stageOne = { model: handedOverModel, assigned: 'c1', standIn: 'c2', stage: 1 }
    assert.deepEqual(handoversShown(), [[stageOne], [stageOne], [stageOne], [stageOne]])
    for (const other of [reporter, c3, c4]) assert.deepEqual(await standInsFor(other), [], `${names.get(other)} leaves it to c2`)

    // Three quarters: it moves on to the second stand-in, c3. c2's slot is over.
    await advance(epochStartedAt + duration * 0.75 + 60 - await chainNow(client.provider))
    const stageTwo = { model: handedOverModel, assigned: 'c1', standIn: 'c3', stage: 2 }
    assert.deepEqual(handoversShown(), [[stageTwo], [stageTwo], [stageTwo], [stageTwo]])
    for (const other of [reporter, c2, c4]) assert.deepEqual(await standInsFor(other), [], `${names.get(other)} leaves it to c3`)

    await dirs.c3.writeRun('c3-stand-in', [audit(handedOverModel, 'SAME')])
    const handedOver = submit('c3', 'c3-stand-in')
    assert.equal(handedOver.status, 0, handedOver.output)
    const modelAudits = await client.queryModelAudits({ model: modelHash(handedOverModel) }, 0)
    assert.deepEqual(modelAudits.map((event) => nameOf(event.auditor)), ['c3'], 'only c3 audited the handed-over model')
    assert.equal((await client.auditCredits(c3.address, AUDIT_EPOCH)).auditor, 2n, 'c3: its own model and the stand-in audit')
    assert.equal((await client.auditCredits(c2.address, AUDIT_EPOCH)).auditor, 1n, 'c2 earned nothing for the slot it missed')
    assert.equal((await client.auditCredits(c1.address, AUDIT_EPOCH)).auditor, 0n)
    assert.deepEqual(handoversShown(), [[], [], [], []], 'once audited, the model is no longer handed over')
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('an all-UNDETERMINED audit does not end a model, and a revoked auditor is skipped at once', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-counting-audit-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const wallets = [AUDITOR_PRIVATE_KEY, SECOND_AUDITOR_PRIVATE_KEY, UNAPPROVED_PRIVATE_KEY].map((key) => new Wallet(`0x${key}`))
    const [working, throttled, revoked] = wallets as [Wallet, Wallet, Wallet]
    const chain = deployAuditChain(rpcUrl, wallets, 1)
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3']
    const rotation = { auditors: wallets.map((wallet) => wallet.address), epoch: AUDIT_EPOCH, availableModels: models }
    const modelOf = (auditor: Wallet) => roundRobinAssignmentFor(auditor.address, rotation).models[0]!
    const seller = randomWallet()
    const audit = (model: string, verdict: FixtureAudit['verdict']): FixtureAudit => ({
      agentId: '1', seller, model, service: model, verdict, reference: referenceFixture(model),
    })
    const dirs = {
      working: await auditorDataDir(directory, 'working', working, chain.crypto, models),
      throttled: await auditorDataDir(directory, 'throttled', throttled, chain.crypto, models),
    }
    const submit = (who: keyof typeof dirs, runId: string) => runCli(dirs[who].dataDir, dirs[who].configPath, rpcUrl, [
      'submit', '--run-id', runId, '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    interface AssignmentJson {
      epochs: Array<{ handovers: Array<{ model: string; assignedAuditor: string; standIn: string; stage: number; revoked: boolean }> }>
    }
    const handoversShown = (who: keyof typeof dirs) => {
      const result = runCli(dirs[who].dataDir, dirs[who].configPath, null, ['assignment', '--json'])
      assert.equal(result.status, 0, result.output)
      return (JSON.parse(result.stdout) as AssignmentJson).epochs[0]!.handovers
    }
    const byModel = (left: { model: string }, right: { model: string }) => left.model.localeCompare(right.model)
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })

    // One auditor gets real answers. Another is throttled and learns nothing, which the contract still takes.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    await dirs.working.writeRun('working-own', [audit(modelOf(working), 'SAME')])
    await dirs.throttled.writeRun('throttled-own', [audit(modelOf(throttled), 'UNDETERMINED')])
    assert.equal(submit('working', 'working-own').status, 0)
    assert.equal(submit('throttled', 'throttled-own').status, 0)
    const onChain = await client.queryModelAudits({ model: modelHash(modelOf(throttled)) }, 0)
    assert.equal(onChain.length, 1, 'the all-UNDETERMINED audit is on-chain')
    assert.deepEqual(handoversShown('working'), [], 'nothing moves before halfway while nobody is revoked')

    // The third auditor is revoked before it audits: its model moves at once, to the only auditor with real answers.
    castSend(rpcUrl, chain.verificationAddress, 'setAuditor(address,bool)', [revoked.address, 'false'])
    await rpc(rpcUrl, 'evm_mine', [])
    const atOnce = [{ model: modelOf(revoked), assignedAuditor: revoked.address, standIn: working.address, stage: 1, revoked: true }]
    assert.ok(await chainNow(client.provider) < epochStartedAt + EPOCH_DURATION / 2)
    assert.deepEqual(handoversShown('working'), atOnce)
    assert.deepEqual(handoversShown('throttled'), atOnce, 'every auditor works out the same stand-in')

    // Halfway: the model audited with nothing learned is handed over too, as if nobody had audited it.
    await rpc(rpcUrl, 'evm_increaseTime', [EPOCH_DURATION / 2])
    await rpc(rpcUrl, 'evm_mine', [])
    const both = [
      ...atOnce,
      { model: modelOf(throttled), assignedAuditor: throttled.address, standIn: working.address, stage: 1, revoked: false },
    ].sort(byModel)
    assert.deepEqual(handoversShown('working'), both)
    assert.deepEqual(handoversShown('throttled'), both)

    // A real audit of that model ends its hand-over.
    await dirs.working.writeRun('working-stand-in', [audit(modelOf(throttled), 'SAME')])
    assert.equal(submit('working', 'working-stand-in').status, 0)
    assert.deepEqual(handoversShown('working'), atOnce)
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

test('submit sends nothing while the auditor has a transaction pending, and sends once it is mined', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-pending-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const epochStartedAt = GENESIS + AUDIT_EPOCH * EPOCH_DURATION
  const anvil = startAnvil(port, { timestamp: epochStartedAt - 120 })
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const wallets = [AUDITOR_PRIVATE_KEY, SECOND_AUDITOR_PRIVATE_KEY].map((key) => new Wallet(`0x${key}`))
    const me = wallets[0]!
    const chain = deployAuditChain(rpcUrl, wallets, 1)
    const models = ['claude-opus-5.5', 'gemini-4-argon', 'glm-5.3']
    const model = roundRobinAssignmentFor(me.address, { auditors: wallets.map((wallet) => wallet.address), epoch: AUDIT_EPOCH, availableModels: models }).models[0]!
    const dirs = await auditorDataDir(directory, 'me', me, chain.crypto, models)
    const submit = () => runCli(dirs.dataDir, dirs.configPath, rpcUrl, [
      'submit', '--run-id', 'own', '--no-publish-ipfs', '--yes', '--skip-version-check',
    ])
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    await dirs.writeRun('own', [{
      agentId: '1', seller: randomWallet(), model, service: model, verdict: 'SAME', reference: referenceFixture(model),
    }])

    // Another transaction from the auditor's wallet that has not mined, e.g. one an earlier submit sent
    // and stopped waiting for: the submit cannot see whether it carried this audit, so it waits.
    await rpc(rpcUrl, 'evm_setAutomine', [false])
    await rpc(rpcUrl, 'eth_sendTransaction', [{ from: me.address, to: me.address, value: '0x0' }])
    const blocked = submit()
    assert.notEqual(blocked.status, 0, blocked.output)
    assert.match(blocked.output, /1 transaction\(s\) from 0x[0-9a-fA-F]{40} are still pending/)
    assert.match(blocked.output, /same nonce/, 'it says how to clear a stuck transaction')
    assert.deepEqual(await client.auditCredits(me.address, AUDIT_EPOCH), { auditor: 0n, total: 0n })

    await rpc(rpcUrl, 'evm_setAutomine', [true])
    await rpc(rpcUrl, 'evm_mine', [])
    const sent = submit()
    assert.equal(sent.status, 0, sent.output)
    assert.match(sent.output, /Submitted: 1; recovered: 0; already submitted: 0; failed: 0/)
    assert.deepEqual(await client.auditCredits(me.address, AUDIT_EPOCH), { auditor: 1n, total: 1n })
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * Deploys the audits contracts in `AUDIT_EPOCH` on a local chain, approves `auditors` (before the
 * epoch starts when the chain was started before it) and registers seller agents 1..`sellerAgents`.
 */
test('a DIFF from the last epoch holds its seller: run does not plan it and submit sends nothing that clears it; the epoch after, it is audited again', {
  skip: !RUN_ANVIL_E2E,
  timeout: 300_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-diff-hold-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  // The fixture runs are dated on 2026-10-07 (epoch AUDIT_EPOCH under GENESIS). The DIFF is recorded the
  // day before, in epoch 5, and each later epoch is moved onto 2026-10-07 by moving genesis back a day,
  // so the CLI's fixture runs fall in it while the chain's clock only moves forward.
  const firstGenesis = GENESIS - EPOCH_DURATION
  const anvil = startAnvil(port, { timestamp: firstGenesis + AUDIT_EPOCH * EPOCH_DURATION - 120 })
  // OpenRouter stand-in for the reference price; nothing else is asked of it.
  const referenceServer = createHttpServer((request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.url === '/api/v1/models') {
      response.end(JSON.stringify({ data: [{ id: 'anthropic/claude-opus-5.5', pricing: { prompt: '0.000005', completion: '0.000025' } }] }))
      return
    }
    response.statusCode = 404
    response.end('{}')
  })
  await new Promise<void>((resolveListen) => referenceServer.listen(0, '127.0.0.1', resolveListen))
  const referencePort = (referenceServer.address() as { port: number }).port
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const auditorA = new Wallet(`0x${AUDITOR_PRIVATE_KEY}`)
    const auditorB = new Wallet(`0x${SECOND_AUDITOR_PRIVATE_KEY}`)
    const chain = deployAuditChain(rpcUrl, [auditorA, auditorB], 2, { genesis: firstGenesis, duration: EPOCH_DURATION })
    const client = new VerifierClient({ rpcUrl, contractAddress: chain.verificationAddress, evmChainId: 31_337, deploymentBlock: 0 })
    const model = 'claude-opus-5.5'
    const honest = randomWallet()
    const cheating = randomWallet()

    // Epoch 5: A audits the model (agent 1 SAME, agent 2 DIFF) and B confirms agent 2's DIFF.
    await rpc(rpcUrl, 'evm_increaseTime', [180])
    await rpc(rpcUrl, 'evm_mine', [])
    const report = async (wallet: Wallet, results: Array<[bigint, 'SAME' | 'DIFF']>) => {
      await client.submitModelAudit(wallet.connect(client.provider), {
        expectedEpoch: BigInt(AUDIT_EPOCH),
        modelHash: modelHash(model),
        evidenceHash: hexlify(randomBytes(32)),
        evidenceUri: '',
        results: sortServiceResults(results.map(([agentId, verdict]) => ({
          agentId, serviceHash: serviceHash(model), verdict: VERIFIER_VERDICT[verdict],
        }))),
      })
    }
    await report(auditorA, [[1n, 'SAME'], [2n, 'DIFF']])
    await report(auditorB, [[2n, 'DIFF']])
    const recorded = await client.serviceStatus(2n, model)
    assert.equal(recorded.verdict, VERIFIER_VERDICT.DIFF)
    assert.equal(recorded.epoch, BigInt(AUDIT_EPOCH))
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 })

    // Epoch 6, on 2026-10-07.
    const enterEpoch = async (epoch: number) => {
      const genesis = GENESIS - (epoch - AUDIT_EPOCH) * EPOCH_DURATION
      castSend(rpcUrl, chain.gateAddress, 'setSchedule(uint256,uint256)', [String(genesis), String(EPOCH_DURATION)])
      castSend(rpcUrl, chain.gateAddress, 'setCurrentEpoch(uint256)', [String(epoch)])
      const now = await chainNow(client.provider)
      const target = GENESIS + AUDIT_EPOCH * EPOCH_DURATION + 180
      if (now < target) await rpc(rpcUrl, 'evm_increaseTime', [target - now])
      await rpc(rpcUrl, 'evm_mine', [])
    }
    await enterEpoch(AUDIT_EPOCH + 1)

    // The buyer the run reads its peers from: both sellers offer the model below the reference price.
    const peerEntry = (seller: Wallet, agentId: number) => ({
      peerId: peerIdOf(seller),
      providers: ['anthropic'],
      lastSeen: Date.now(),
      capabilities: ['verification.response-auth.v1'],
      onChainAgentId: agentId,
      providerPricing: { anthropic: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { [model]: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } } },
    })
    const dataDirFor = async (name: string, wallet: Wallet, verifier: Record<string, unknown> = {}) => {
      const dataDir = join(directory, name)
      const evidenceDir = join(dataDir, 'verifier', 'evidence')
      const banksDir = join(dataDir, 'verifier', 'banks')
      const configPath = join(dataDir, 'config.json')
      await mkdir(dataDir, { recursive: true })
      await writeFile(join(dataDir, 'identity.key'), `${wallet.privateKey.slice(2)}\n`, { mode: 0o600 })
      await writeFile(join(dataDir, 'buyer.state.json'), JSON.stringify({
        state: 'connected',
        pid: process.pid,
        port: await availablePort(),
        discoveredPeers: [peerEntry(honest, 1), peerEntry(cheating, 2)],
        settings: { minPeerReputation: 0, maxPricing: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
      }))
      // The buyer's ResponseAuth store, which a run opens before it plans.
      new VerificationStorage(join(dataDir, 'verification.db')).close()
      await writeFile(configPath, JSON.stringify({
        payments: { preferredMethod: 'crypto', crypto: chain.crypto },
        verifier: {
          evidenceDir, banksDir, auditor: wallet.address, testModels: [model], ...FIXTURE_CONFIG,
          referenceEndpoint: { baseUrl: `http://127.0.0.1:${referencePort}/api/v1`, sourceId: 'openrouter', trust: 'trusted' },
          ...verifier,
        },
      }))
      return { dataDir, configPath, evidenceDir, banksDir }
    }
    // Plans the run and stops before any request: `--no-enroll` leaves the model without a question set.
    // Not `runCli`: the run asks this process's reference server for the price, so the test must keep serving.
    const plan = (dirs: { dataDir: string; configPath: string }) => runCliAsync(dirs.dataDir, dirs.configPath, null, [
      'run', model, '--no-enroll', '--ignore-pre-run-checks', '--skip-version-check', '--max-rounds', '1',
    ], { env: { HOME: directory } })
    const a = await dataDirFor('auditor-a', auditorA)
    const heldLine = new RegExp(`${model}: agent 2 \\(${model}, peer ${peerIdOf(cheating).slice(0, 12)}…\\) held: its DIFF from epoch 5 stands until epoch 7`)

    const planned = await plan(a)
    assert.match(planned.output, heldLine, planned.output)
    assert.match(planned.output, /auditing 1 seller\(s\) planned for this run; 1 held after a recent DIFF, not audited this epoch/, planned.output)
    assert.match(planned.output, new RegExp(`${model}: 1 eligible target\\(s\\), 0 skipped`), planned.output)
    assert.doesNotMatch(planned.output, /agent 1 .* held/)
    // The model's audit window, opened by this run, leaves the held seller out too.
    const window = await readAuditWindow(a.evidenceDir, String(AUDIT_EPOCH + 1), model)
    assert.ok(window, planned.output)
    assert.equal(windowIncludesSeller(window, peerIdOf(honest)), true)
    assert.equal(windowIncludesSeller(window, peerIdOf(cheating)), false)

    // With the hold off, both sellers are planned: the setting is what holds agent 2.
    const off = await dataDirFor('auditor-a-no-hold', auditorA, { diffHoldEpochs: 0 })
    const plannedWithoutHold = await plan(off)
    assert.doesNotMatch(plannedWithoutHold.output, / held: /, plannedWithoutHold.output)
    assert.match(plannedWithoutHold.output, /auditing 2 seller\(s\) planned for this run\./, plannedWithoutHold.output)
    assert.match(plannedWithoutHold.output, /verifier\.diffHoldEpochs is 0; these rules use 1/, 'a hold set away from the rules is named')

    // A result for agent 2 that a run made anyway (here a SAME, from a data dir without that window) is
    // left out at submit by the hold itself; agent 1's is sent.
    const submitter = await dataDirFor('auditor-a-submit', auditorA)
    const epochRun = (dirs: typeof a, runId: string, epoch: number, audits: FixtureAudit[]) => writeSignedAuditRun({
      evidenceDir: dirs.evidenceDir, banksDir: dirs.banksDir, runId, epoch: String(epoch), auditor: auditorA, audits,
    })
    const audit = (agentId: string, seller: Wallet): FixtureAudit => ({
      agentId, seller, model, service: model, verdict: 'SAME', reference: referenceFixture(model),
    })
    await epochRun(submitter, 'a-epoch-6', AUDIT_EPOCH + 1, [audit('1', honest), audit('2', cheating)])
    const submitted = runCli(submitter.dataDir, submitter.configPath, rpcUrl, [
      'submit', '--run-id', 'a-epoch-6', '--no-publish-ipfs', '--yes', '--skip-version-check',
    ], { env: { HOME: directory } })
    assert.equal(submitted.status, 0, submitted.output)
    assert.match(submitted.output, /\(2\): excluded: its DIFF from epoch 5 stands until epoch 7, so the seller is not audited or cleared before then/, submitted.output)
    const sent = await client.queryModelAudits({ model: modelHash(model) }, 0)
    assert.equal(sent.at(-1)?.resultCount, 1, 'only agent 1 was sent')
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 0, diffCount: 1 }, 'the DIFF still counts in epoch 6')
    assert.equal((await client.serviceStatus(2n, model)).epoch, BigInt(AUDIT_EPOCH))

    // Epoch 7: the hold is over, so agent 2 is planned again and its SAME is recorded.
    await enterEpoch(AUDIT_EPOCH + 2)
    const replanned = await plan(a)
    assert.doesNotMatch(replanned.output, / held: /, replanned.output)
    assert.match(replanned.output, /auditing 2 seller\(s\) planned for this run\./, replanned.output)
    await epochRun(submitter, 'a-epoch-7', AUDIT_EPOCH + 2, [audit('2', cheating)])
    const cleared = runCli(submitter.dataDir, submitter.configPath, rpcUrl, [
      'submit', '--run-id', 'a-epoch-7', '--no-publish-ipfs', '--yes', '--skip-version-check',
    ], { env: { HOME: directory } })
    assert.equal(cleared.status, 0, cleared.output)
    const after = await client.serviceStatus(2n, model)
    assert.equal(after.verdict, VERIFIER_VERDICT.SAME)
    assert.equal(after.epoch, BigInt(AUDIT_EPOCH + 2))
    assert.deepEqual(await client.agentStatus(2n), { verifiedCount: 1, diffCount: 0 })
  } finally {
    referenceServer.close()
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

function deployAuditChain(
  rpcUrl: string,
  auditors: readonly Wallet[],
  sellerAgents: number,
  schedule: { genesis: number; duration: number } = { genesis: GENESIS, duration: EPOCH_DURATION },
) {
  const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
  const identityRegistryAddress = deployContract(rpcUrl, 'test/mocks/MockERC8004Registry.sol:MockERC8004Registry')
  const gateAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationEmissionsGate.sol:MockVerificationEmissionsGate')
  const poolsAddress = deployContract(rpcUrl, 'test/mocks/MockVerificationSellerPools.sol:MockVerificationSellerPools')
  castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
  castSend(rpcUrl, registryAddress, 'setEmissions(address)', [gateAddress])
  const { resultsAddress, kbfAddress: verificationAddress } = deployVerification(rpcUrl, gateAddress, poolsAddress, identityRegistryAddress)
  castSend(rpcUrl, resultsAddress, 'setRewardsStartEpoch(address,uint64)', [verificationAddress, '0'])
  castSend(rpcUrl, gateAddress, 'setCurrentEpoch(uint256)', [String(AUDIT_EPOCH)])
  castSend(rpcUrl, gateAddress, 'setSchedule(uint256,uint256)', [String(schedule.genesis), String(schedule.duration)])
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
  return { verificationAddress, gateAddress, crypto }
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
  const writeRun = (runId: string, audits: FixtureAudit[], completedAt?: string) => (
    writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: EPOCH, auditor: wallet, audits, ...(completedAt ? { completedAt } : {}) })
  )
  return { dataDir, configPath, writeRun }
}

function cliArgs(
  dataDir: string,
  configPath: string,
  rpcUrl: string | null,
  args: string[],
  options: RunCliOptions,
): string[] {
  return [
    ...(options.importPath ? ['--import', options.importPath] : []),
    cliEntry,
    '--data-dir', dataDir,
    '--config', configPath,
    'verifier',
    ...args,
    ...(rpcUrl ? ['--rpc-url', rpcUrl] : []),
  ]
}

function runCli(
  dataDir: string,
  configPath: string,
  /** `--rpc-url` for commands that take it; null for those that read `payments.crypto.rpcUrl`. */
  rpcUrl: string | null,
  args: string[],
  options: RunCliOptions = {},
): CommandResult {
  const result = spawnSync(process.execPath, cliArgs(dataDir, configPath, rpcUrl, args, options), {
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

/** `runCli` without blocking this process, for a command that calls a server the test itself runs. */
async function runCliAsync(
  dataDir: string,
  configPath: string,
  rpcUrl: string | null,
  args: string[],
  options: RunCliOptions = {},
): Promise<CommandResult> {
  const child = spawn(process.execPath, cliArgs(dataDir, configPath, rpcUrl, args, options), {
    cwd: repoRoot,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1', ...options.env },
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk })
  const [code] = await once(child, 'close') as [number | null]
  return { status: code ?? 1, output: `${stdout}${stderr}`, stdout }
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

async function writeMockPinataPreload(path: string, logPath: string, storeDir?: string): Promise<void> {
  await writeFile(path, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'

const originalFetch = globalThis.fetch
const logPath = ${JSON.stringify(logPath)}
// With a store, each upload is kept under <store>/<cid>/<path> and the default IPFS gateway serves it,
// so another auditor's CLI reads the published evidence as it would from IPFS.
const store = ${JSON.stringify(storeDir ?? null)}
const gateway = 'https://ipfs.io/ipfs/'

globalThis.fetch = async (input, init) => {
  const url = String(input)
  if (store && url.startsWith(gateway)) {
    const path = resolve(store, ...url.slice(gateway.length).split('/').map(decodeURIComponent))
    if (!path.startsWith(resolve(store) + sep) || !existsSync(path)) return new Response('not found', { status: 404 })
    return new Response(readFileSync(path), { status: 200 })
  }
  if (url !== 'https://uploads.pinata.cloud/v3/files') {
    return originalFetch(input, init)
  }
  // A test makes Pinata fail by creating <log>.fail.
  if (existsSync(logPath + '.fail')) return new Response('unavailable', { status: 503 })
  const form = init.body
  const metadata = JSON.parse(String(form.get('keyvalues')))
  const files = form.getAll('file')
  appendFileSync(logPath, JSON.stringify({
    model: metadata.model,
    evidenceHash: metadata.evidenceHash,
    files: files.map((file) => file.name),
  }) + '\\n')
  const cid = store
    // A CIDv1 in base32 (b, then a to z and 2 to 7), one per evidence hash: each hex digit becomes a letter.
    ? 'bafy' + String(metadata.evidenceHash).slice(2).toLowerCase().replace(/[0-9a-f]/g, (digit) => 'abcdefghijklmnop'[parseInt(digit, 16)])
    : 'bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghp' + (metadata.model === 'model-a' ? 'm' : 'n')
  if (store) {
    for (const file of files) {
      const target = join(store, cid, file.name)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, Buffer.from(await file.arrayBuffer()))
    }
  }
  return new Response(JSON.stringify({
    data: {
      cid,
      size: files.reduce((total, file) => total + file.size, 0),
      created_at: '2026-10-07T12:00:00.000Z',
    },
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
`)
}

/** A confirmation's audit time: an hour and a minute after the chain's time now, so it is fresh material (`same-check.ts`). */
async function confirmationTime(provider: Parameters<typeof chainNow>[0]): Promise<string> {
  return new Date((await chainNow(provider) + 3_660) * 1_000).toISOString()
}

/**
 * Pinata and the IPFS gateway, mocked for every CLI the test starts: a confirming auditor reads which
 * check flagged in the first auditor's DIFF from its published evidence (`same-check.ts`), so the
 * auditor that reports a DIFF publishes it here.
 */
async function mockIpfs(directory: string): Promise<{ options: RunCliOptions; logPath: string }> {
  const logPath = join(directory, 'pinata-uploads.jsonl')
  const importPath = join(directory, 'mock-ipfs.mjs')
  await writeMockPinataPreload(importPath, logPath, join(directory, 'ipfs-store'))
  return { options: { importPath, env: { PINATA_JWT: 'test-pinata-jwt' } }, logPath }
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

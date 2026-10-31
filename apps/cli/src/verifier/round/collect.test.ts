import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet, getAddress, keccak256, toUtf8Bytes, type AbstractSigner } from 'ethers'
import { ZERO_HASH, type CommitmentEvent, type KbfEpochInfo, type KbfRoundClient } from '@antseed/node/payments'
import type { ResponseAuthReader } from '../response-auth-reader.js'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { derivePlan, envelopeFor } from './plan.js'
import { contentHash, generateEncryptionKeyPair, sealEnvelope } from './sealing.js'
import { DirectoryRoundStorage } from './storage.js'
import type { EpochBankV1, PlanFileV1, RoundTargetV1, SliceManifestV1 } from './types.js'
import { encodeRoundFile, verifierTick, type VerifierDaemonContext } from './verifier-daemon.js'

const EPOCH = 7n
const EPOCH_SECONDS = 7 * 24 * 3600
const START = Number(EPOCH) * EPOCH_SECONDS
const COLLECT_SECONDS = 3 * 24 * 3600
const MODEL = 'model-a'
const MODEL_HASH = keccak256(toUtf8Bytes(MODEL))
const SEED = `0x${'ab'.repeat(32)}`

/** The chain as one verifier sees it while it collects: a committed plan, and slice commits. */
class CollectChain {
  time = START + 3600
  slices: CommitmentEvent[] = []
  failCommits = 0
  commits = 0
  constructor(readonly info: KbfEpochInfo, readonly plans: CommitmentEvent[], readonly members: string[]) {}

  async currentEpoch(): Promise<bigint> { return EPOCH }
  async epochInfo(epoch: bigint): Promise<KbfEpochInfo> {
    if (epoch === EPOCH) return { ...this.info }
    return { ...this.info, epoch, finalizedRoot: ZERO_HASH, planHash: ZERO_HASH, voided: false }
  }
  async epochDuration(): Promise<number> { return EPOCH_SECONDS }
  async now(): Promise<number> { return this.time }
  async epochVerifiers(): Promise<string[]> { return this.members }
  async planCommits(): Promise<CommitmentEvent[]> { return this.plans }
  async sliceCommits(): Promise<CommitmentEvent[]> { return this.slices }
  async commitSlices(signer: AbstractSigner, epoch: bigint, hash: string, uri: string): Promise<string> {
    this.commits++
    if (this.failCommits > 0) {
      this.failCommits--
      throw new Error('nonce too low')
    }
    const backup = this.time >= this.info.startedAt + this.info.schedule.collectSeconds
    this.slices.push({ epoch, hash, uri, backup, sender: getAddress(await signer.getAddress()), blockNumber: 1, logIndex: 0, txHash: '0x' })
    return '0xtx'
  }
}

interface Setup {
  dir: string
  chain: CollectChain
  storage: DirectoryRoundStorage & { failPuts: number }
  requests: string[]
  context: VerifierDaemonContext
  logs: string[]
  /** Seconds of chain time each purchase takes. */
  setRequestSeconds: (seconds: number) => void
}

async function setup(): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-round-collect-'))
  const me = new Wallet(Wallet.createRandom().privateKey)
  const keys = generateEncryptionKeyPair()
  const seller = new Wallet(Wallet.createRandom().privateKey)
  const target: RoundTargetV1 = {
    agentId: '1', peerId: seller.address.slice(2).toLowerCase(), service: MODEL, serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH,
  }
  const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: EPOCH.toString(), models: { [MODEL]: referenceFixture(MODEL, 80) } }
  const plan = derivePlan({ epoch: EPOCH.toString(), seed: SEED, probesPerService: 80, slicesPerService: 2, verifiers: [me.address], targets: [target], bank })
  const envelope = envelopeFor(plan, bank, me.address, { backup: false })
  const planFile: PlanFileV1 = {
    kind: 'antseed-kbf-plan', version: 1, epoch: EPOCH.toString(), seed: SEED, backup: false, targets: [target],
    envelopes: { [me.address.toLowerCase()]: sealEnvelope(keys.publicKey, encodeRoundFile(envelope)) },
  }
  const files = new DirectoryRoundStorage(join(dir, 'files'))
  const planBytes = encodeRoundFile(planFile)
  const planUri = await files.put(planBytes)
  const planHash = contentHash(planBytes)
  const info: KbfEpochInfo = {
    epoch: EPOCH, startedAt: START, seedBlock: 10n, seed: SEED, modelsVersion: 1, verifierCount: 1,
    schedule: { collectSeconds: COLLECT_SECONDS, backupSeconds: 86400, attestSeconds: 86400, probesPerService: 80, slicesPerService: 2 },
    bankHash: `0x${'01'.repeat(32)}`, bankKeyHash: `0x${'02'.repeat(32)}`, bankKey: ZERO_HASH, planHash, backupPlanHash: ZERO_HASH,
    finalizedRoot: ZERO_HASH, voided: false, publisher: me.address, takenOverAt: 0, keySharesHash: `0x${'03'.repeat(32)}`,
  }
  const chain = new CollectChain(info, [{ epoch: EPOCH, hash: planHash, uri: planUri, backup: false, sender: me.address, blockNumber: 1, logIndex: 0, txHash: '0x' }], [getAddress(me.address)])

  const storage = Object.assign(files, { failPuts: 0 })
  const put = files.put.bind(files)
  storage.put = async (bytes: Uint8Array) => {
    if (storage.failPuts > 0) {
      storage.failPuts--
      throw new Error('gateway timeout')
    }
    return put(bytes)
  }

  const requests: string[] = []
  let requestSeconds = 0
  const records = new Map<string, unknown>()
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const requestId = (init!.headers as Record<string, string>)['x-antseed-request-id']!
    requests.push(requestId)
    chain.time += requestSeconds
    records.set(requestId, {
      requestId, status: 'verified', failureReason: null,
      responseAuth: { version: 1, requestId, buyerPeerId: 'b', sellerPeerId: target.peerId, advertisedService: MODEL, provider: 'openai', statusCode: 200, requestHash: '0x', responseHash: '0x', responseStartedAt: 1, responseCompletedAt: 2, signature: '0x' },
      signedPreimages: { requestBase64: 'cQ==', responseBase64: 'cg==' },
    })
    return new Response('{}', { status: 200 })
  }) as typeof fetch
  const reader = { waitForVerified: async ({ requestId }: { requestId: string }) => records.get(requestId), close: () => {} } as unknown as ResponseAuthReader
  const logs: string[] = []
  const context: VerifierDaemonContext = {
    client: chain as unknown as KbfRoundClient,
    signer: me as never,
    address: me.address,
    encryptionPrivateKey: keys.privateKey,
    storage,
    bindings: { isBound: async () => true },
    stateDir: join(dir, 'state'),
    collector: { buyerUrl: 'http://buyer.test', responseAuth: reader, log: () => {}, fetchImpl },
    log: (line) => logs.push(line),
  }
  return { dir, chain, storage, requests, context, logs, setRequestSeconds: (seconds) => { requestSeconds = seconds } }
}

async function batchesPlanned(s: Setup): Promise<number> {
  const manifest = JSON.parse(await readFile(join(s.context.stateDir, EPOCH.toString(), 'slices.json'), 'utf8')) as SliceManifestV1
  return manifest.slices.reduce((sum, slice) => sum + slice.exchanges.length, 0)
}

test('a failed upload or commit retries publication only: every batch is bought once', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  s.storage.failPuts = 1
  await assert.rejects(verifierTick(s.context), /gateway timeout/)
  const bought = s.requests.length
  assert.ok(bought > 0)
  assert.equal(await batchesPlanned(s), bought, 'the collected manifest is on disk before the upload')

  s.chain.failCommits = 1
  await assert.rejects(verifierTick(s.context), /nonce too low/)
  await verifierTick(s.context)
  assert.equal(s.requests.length, bought, 'no batch was bought again')
  assert.equal(s.chain.slices.length, 1)
  assert.equal(s.chain.slices[0]!.backup, false)

  await verifierTick(s.context)
  assert.equal(s.chain.commits, 2, 'a committed phase is done')
})

test('a commit that landed although its receipt was lost is adopted, not bought again', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const commit = s.chain.commitSlices.bind(s.chain)
  s.chain.commitSlices = async (...args) => {
    await commit(...args)
    throw new Error('receipt timeout')
  }
  await assert.rejects(verifierTick(s.context), /receipt timeout/)
  const bought = s.requests.length
  s.chain.commitSlices = commit
  await verifierTick(s.context)
  assert.equal(s.requests.length, bought)
  assert.equal(s.chain.slices.length, 1, 'not committed twice')
  assert.ok(s.logs.some((line) => line.includes('already committed')))
})

test('a crash mid-collection resumes from the batches already bought', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const reader = s.context.collector!.responseAuth
  let calls = 0
  s.context.collector!.responseAuth = {
    ...reader,
    waitForVerified: async (input) => {
      if (++calls === 3) throw new Error('process killed')
      return reader.waitForVerified(input)
    },
  }
  await assert.rejects(verifierTick(s.context), /process killed/)
  assert.equal(s.requests.length, 3)
  await verifierTick(s.context)
  const batches = await batchesPlanned(s)
  assert.ok(batches > 3)
  assert.equal(s.requests.length, batches + 1, 'only the batch cut off by the crash is bought again')
  assert.equal(s.chain.slices.length, 1)
})

test('collection stops before the primary deadline and never commits a primary manifest late', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const deadline = START + COLLECT_SECONDS
  // Starts 20 minutes before the deadline; each purchase takes 4 minutes.
  s.chain.time = deadline - 20 * 60
  s.setRequestSeconds(4 * 60)
  await verifierTick(s.context)
  assert.equal(s.requests.length, 4, 'stopped buying once less than five minutes were left')
  assert.ok(await batchesPlanned(s) === 4)
  assert.ok(s.logs.some((line) => line.includes('stopped buying')))
  assert.equal(s.chain.slices.length, 1, 'what was collected is committed in time')
  assert.equal(s.chain.slices[0]!.backup, false)

  const late = await setup()
  t.after(() => rm(late.dir, { recursive: true, force: true }))
  // A purchase that runs past the deadline: the manifest would land in the backup phase.
  late.chain.time = deadline - 6 * 60
  late.setRequestSeconds(10 * 60)
  await verifierTick(late.context)
  assert.equal(late.requests.length, 1)
  assert.equal(late.chain.slices.length, 0, 'never committed after its phase')
  assert.ok(late.logs.some((line) => line.includes('phase over before the slices were committed')))
  await verifierTick(late.context)
  assert.equal(late.chain.commits, 0)
})

test('an upload that runs past the deadline is not committed into the backup phase', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const deadline = START + COLLECT_SECONDS
  s.chain.time = deadline - 20 * 60
  const put = s.storage.put.bind(s.storage)
  s.storage.put = async (bytes: Uint8Array) => {
    s.chain.time += 25 * 60
    return put(bytes)
  }
  await verifierTick(s.context)
  assert.ok(s.requests.length > 0)
  assert.equal(s.chain.commits, 0, 'the commit would land after the primary deadline')
  assert.ok(s.logs.some((line) => line.includes('phase over before the slices were committed')))
  assert.ok(await batchesPlanned(s) > 0, 'the manifest stays on disk')
})

test('a failing current epoch does not hold back earlier epochs', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const asked: bigint[] = []
  const epochInfo = s.chain.epochInfo.bind(s.chain)
  s.chain.epochInfo = async (epoch: bigint) => {
    asked.push(epoch)
    return epochInfo(epoch)
  }
  s.chain.planCommits = async () => { throw new Error('rpc down') }
  await assert.rejects(verifierTick(s.context), /epoch 7: .*rpc down/)
  assert.ok(asked.includes(EPOCH - 1n) && asked.includes(EPOCH - 2n), 'earlier epochs were still applied and claimed')
})

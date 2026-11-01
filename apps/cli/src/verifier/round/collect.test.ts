import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet, getAddress, keccak256, toUtf8Bytes, type AbstractSigner } from 'ethers'
import { ZERO_HASH, type CommitmentEvent, type KbfEpochInfo, type KbfRoundClient } from '@antseed/node/payments'
import type { KbfReferenceV1 } from '@antseed/fingerprints'
import type { ResponseAuthReader } from '../response-auth-reader.js'
import { THINKING_FALLBACK_MAX_TOKENS } from '../thinking-suppression.js'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { derivePlan, envelopeFor } from './plan.js'
import { contentHash, generateEncryptionKeyPair, sealEnvelope } from './sealing.js'
import { ENVELOPE_MAX_TOKENS } from './envelope-check.js'
import { DirectoryRoundStorage } from './storage.js'
import { buildResultsTree, collectorLeaf } from './merkle.js'
import type { EnvelopeContentV1, EpochBankV1, PlanFileV1, RoundPlanV1, RoundResultsV1, RoundTargetV1, SliceManifestV1 } from './types.js'
import { encodeRoundFile } from './encoding.js'
import { verifierTick, type VerifierDaemonContext } from './verifier-daemon.js'
import type { CollectorContext } from './collector.js'

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
  async models(): Promise<Array<{ modelHash: string; service: string }>> { return [{ modelHash: MODEL_HASH, service: MODEL }] }
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
  plan: RoundPlanV1
  me: string
}

interface SetupOptions {
  /** Other verifiers in the epoch snapshot (default: none). */
  others?: number
  /** Edits this verifier's envelope before it is sealed, as a dishonest publisher would. */
  tamper?: (envelope: EnvelopeContentV1) => void
  maxRequestsPerEpoch?: number
  /** Edits the bank's reference before the plan is derived. */
  reference?: (reference: KbfReferenceV1) => void
  /** This collector's own price check (default: every target is affordable). */
  affordable?: CollectorContext['affordable']
}

async function setup(options: SetupOptions = {}): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-round-collect-'))
  const me = new Wallet(Wallet.createRandom().privateKey)
  const others = Array.from({ length: options.others ?? 0 }, () => Wallet.createRandom().address)
  const members = [me.address, ...others]
  const keys = generateEncryptionKeyPair()
  const seller = new Wallet(Wallet.createRandom().privateKey)
  const target: RoundTargetV1 = {
    agentId: '1', peerId: seller.address.slice(2).toLowerCase(), service: MODEL, serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH,
  }
  const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: EPOCH.toString(), models: { [MODEL]: referenceFixture(MODEL, 80) } }
  options.reference?.(bank.models[MODEL]!)
  const plan = derivePlan({ epoch: EPOCH.toString(), seed: SEED, probesPerService: 80, slicesPerService: 4, verifiers: members, targets: [target], bank })
  const envelope = envelopeFor(plan, bank, me.address, { backup: false })
  options.tamper?.(envelope)
  const backupEnvelope = envelopeFor(plan, bank, me.address, { backup: true })
  const sealed = (content: EnvelopeContentV1) => content.slices.length > 0 ? { [me.address.toLowerCase()]: sealEnvelope(keys.publicKey, encodeRoundFile(content)) } : {}
  const planFile: PlanFileV1 = {
    kind: 'antseed-kbf-plan', version: 1, epoch: EPOCH.toString(), seed: SEED, targets: [target],
    envelopes: sealed(envelope), backupEnvelopes: sealed(backupEnvelope),
  }
  const files = new DirectoryRoundStorage(join(dir, 'files'))
  const planBytes = encodeRoundFile(planFile)
  const planUri = await files.put(planBytes)
  const planHash = contentHash(planBytes)
  const info: KbfEpochInfo = {
    epoch: EPOCH, startedAt: START, seedBlock: 10n, seed: SEED, modelsVersion: 1, verifierCount: 1,
    schedule: { collectSeconds: COLLECT_SECONDS, backupSeconds: 86400, attestSeconds: 86400, probesPerService: 80, slicesPerService: 4 },
    bankHash: `0x${'01'.repeat(32)}`, bankKeyHash: `0x${'02'.repeat(32)}`, bankKey: ZERO_HASH, planHash,
    finalizedRoot: ZERO_HASH, voided: false, publisher: me.address, takenOverAt: 0, keySharesHash: `0x${'03'.repeat(32)}`, planActive: true,
  }
  const chain = new CollectChain(info, [{ epoch: EPOCH, hash: planHash, uri: planUri, backup: false, sender: me.address, blockNumber: 1, logIndex: 0, txHash: '0x' }], members.map((member) => getAddress(member)))

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
    collector: { buyerUrl: 'http://buyer.test', responseAuth: reader, log: () => {}, fetchImpl, affordable: options.affordable ?? (async (targets) => targets) },
    ...(options.maxRequestsPerEpoch === undefined ? {} : { maxRequestsPerEpoch: options.maxRequestsPerEpoch }),
    log: (line) => logs.push(line),
  }
  return {
    dir, chain, storage, requests, context, logs, setRequestSeconds: (seconds) => { requestSeconds = seconds },
    plan, me: me.address.toLowerCase(),
  }
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

test('a reference built with the unsuppressed thinking fallback is collected', async (t) => {
  // `bare-expanded` asks for the largest per-request budget any reference strategy uses.
  const s = await setup({ reference: (reference) => { reference.queryProfile = { ...reference.queryProfile, maxTokensPerRequest: THINKING_FALLBACK_MAX_TOKENS } } })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  await verifierTick(s.context)
  assert.ok(s.requests.length > 0, 'the envelope was accepted and its slices bought')
  assert.equal(THINKING_FALLBACK_MAX_TOKENS <= ENVELOPE_MAX_TOKENS, true)
})

test('a recovered results file with checksummed collectors still claims the collector share', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const previous = EPOCH - 1n
  const credits = [{ collector: getAddress(s.me), slices: 3 }]
  const tree = buildResultsTree(previous, { results: [], credits, totalSlices: 4 })
  const file: RoundResultsV1 = { kind: 'antseed-kbf-results', version: 1, epoch: previous.toString(), seed: SEED, results: [], credits, totalSlices: 4, root: tree.root }
  const uri = await s.storage.put(encodeRoundFile(file))
  const chain = s.chain as unknown as Record<string, unknown>
  const epochInfo = s.chain.epochInfo.bind(s.chain)
  chain.epochInfo = async (epoch: bigint) => epoch === previous ? { ...(await epochInfo(EPOCH)), epoch, finalizedRoot: tree.root } : epochInfo(epoch)
  chain.attestationEvents = async () => [{ epoch: previous, hash: tree.root, uri, backup: false, sender: s.me, blockNumber: 1, logIndex: 0, txHash: '0x' }]
  chain.rewardClaimed = async () => false
  const claims: Array<{ slices: number; totalSlices: number; proof: string[] }> = []
  chain.pendingReward = async () => 1n
  chain.claimRewards = async (_signer: unknown, _epoch: bigint, slices: number, totalSlices: number, proof: string[]) => {
    claims.push({ slices, totalSlices, proof })
    return '0xclaim'
  }
  await verifierTick(s.context).catch(() => {})
  assert.deepEqual(claims.map((claim) => [claim.slices, claim.totalSlices]), [[3, 4]])
  assert.deepEqual(claims[0]!.proof, tree.proof(collectorLeaf(previous, s.me, 3, 4)))
})

test('an envelope with work the plan does not assign buys nothing', async (t) => {
  const cases: Array<[string, (envelope: EnvelopeContentV1) => void, RegExp]> = [
    ['a slice index beyond the schedule', (envelope) => { envelope.slices.push({ ...envelope.slices[0]!, sliceIndex: 9 }) }, /out of range/],
    ['the same slice twice', (envelope) => { envelope.slices.push(envelope.slices[0]!) }, /appears twice/],
    ['more questions than the schedule', (envelope) => {
      const slice = envelope.slices[0]!
      const extra = slice.batches.map((batch, index) => ({ ...batch, batchIndex: 70 + index, probeIds: batch.probeIds.map((id) => `${id}-x`), probes: batch.probes.map((probe) => ({ ...probe, id: `${probe.id}-x` })) }))
      for (let copy = 0; copy < 4; copy++) slice.batches.push(...extra.map((batch) => ({ ...batch, batchIndex: batch.batchIndex - 10 * copy, probeIds: batch.probeIds.map((id) => `${id}${copy}`), probes: batch.probes.map((probe) => ({ ...probe, id: `${probe.id}${copy}` })) })))
    }, /more than 80 questions/],
    ['a target that is not on the plan', (envelope) => { envelope.slices[0] = { ...envelope.slices[0]!, target: { ...envelope.slices[0]!.target, agentId: '99' } } }, /not an audited target of the plan/],
    ['a huge output budget', (envelope) => { envelope.slices[0]!.request = { ...envelope.slices[0]!.request, maxTokens: 1_000_000 } }, /max tokens/],
    ['extra request fields', (envelope) => { envelope.slices[0]!.request = { ...envelope.slices[0]!.request, thinkingOverrides: { tools: [{ type: 'web_search' }] } } }, /other than thinking settings/],
    ['an inflated question', (envelope) => { envelope.slices[0]!.batches[0]!.probes[0] = { ...envelope.slices[0]!.batches[0]!.probes[0]!, template: 'x'.repeat(5_000) } }, /too long/],
  ]
  for (const [label, tamper, reason] of cases) {
    const s = await setup({ tamper })
    t.after(() => rm(s.dir, { recursive: true, force: true }))
    await assert.rejects(verifierTick(s.context), reason, label)
    assert.equal(s.requests.length, 0, `${label}: no paid request`)
  }

  // A slice that the seed assigns to another verifier, copied into this one's envelope.
  let checked = false
  for (let attempt = 0; attempt < 20 && !checked; attempt++) {
    const s = await setup({
      others: 3,
      tamper: (envelope) => {
        const own = new Set(envelope.slices.map((slice) => slice.sliceIndex))
        const foreign = [0, 1, 2, 3].find((index) => !own.has(index))
        if (foreign !== undefined && envelope.slices[0]) envelope.slices.push({ ...envelope.slices[0], sliceIndex: foreign })
      },
    })
    t.after(() => rm(s.dir, { recursive: true, force: true }))
    const owned = s.plan.slices.filter((slice) => slice.owner === s.me).length
    if (owned === 0 || owned === s.plan.slices.length) continue
    await assert.rejects(verifierTick(s.context), /not assigned to this verifier/)
    assert.equal(s.requests.length, 0)
    checked = true
  }
  assert.ok(checked, 'a fixture where this verifier owns some but not all slices')
})

test('nothing is bought from a target this collector cannot afford at current prices, whatever the plan says', async (t) => {
  const seen: string[][] = []
  const s = await setup({
    // The seller raised its price above this verifier's audit cap after the plan went out.
    affordable: async (_targets, models) => {
      seen.push(models.map((model) => model.service))
      return []
    },
  })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  await verifierTick(s.context)
  assert.equal(s.requests.length, 0, 'no paid request')
  assert.deepEqual(seen, [[MODEL]], 'checked against the epoch\'s audited models')
})

test('purchases stop at the per-epoch budget whatever the envelope asks for', async (t) => {
  const s = await setup({ maxRequestsPerEpoch: 3 })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  await verifierTick(s.context)
  assert.equal(s.requests.length, 3)
  assert.ok(s.logs.some((line) => line.includes('reached the budget of 3 requests')))
  assert.equal(s.chain.slices.length, 1, 'what was bought is still committed')
})

test('every request attempt counts against the budget, retries of unsigned 200s included', async (t) => {
  const s = await setup({ maxRequestsPerEpoch: 1 })
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  // The seller answers 200 but no signed record ever shows up: the collector would retry.
  s.context.collector!.responseAuth = {
    waitForVerified: async ({ requestId }: { requestId: string }) => ({ requestId, status: 'missing', failureReason: 'no record' }),
    close: () => {},
  } as unknown as ResponseAuthReader
  await verifierTick(s.context)
  assert.equal(s.requests.length, 1, 'one request allowed, one sent')
  const state = JSON.parse(await readFile(join(s.context.stateDir, EPOCH.toString(), 'state.json'), 'utf8')) as { requestsSent?: number }
  assert.equal(state.requestsSent, 1, 'counted before it was sent')
  assert.ok(s.logs.some((line) => line.includes('reached the budget of 1 requests')))
})

test('backups need no publisher step: undelivered backed-up slices are bought after the deadline', async (t) => {
  // Find a fixture where this verifier backs up at least one slice of another owner.
  let s: Setup | null = null
  for (let attempt = 0; attempt < 20 && !s; attempt++) {
    const candidate = await setup({ others: 2 })
    t.after(() => rm(candidate.dir, { recursive: true, force: true }))
    if (candidate.plan.slices.some((slice) => slice.backup === candidate.me && slice.owner !== candidate.me)) s = candidate
  }
  assert.ok(s, 'a fixture with backed-up slices')
  const backedUp = s.plan.slices.filter((slice) => slice.backup === s!.me && slice.owner !== s!.me)
  const ownBatches = s.plan.slices.filter((slice) => slice.owner === s!.me).reduce((sum, slice) => sum + slice.batches.length, 0)
  await verifierTick(s.context)
  assert.equal(s.requests.length, ownBatches, 'only its own slices before the commit deadline')

  // The owners delivered nothing; nobody publishes anything after the plan.
  s.chain.time = START + COLLECT_SECONDS + 60
  await verifierTick(s.context)
  const backupBatches = backedUp.reduce((sum, slice) => sum + slice.batches.length, 0)
  assert.equal(s.requests.length, ownBatches + backupBatches, 'every backed-up slice was bought')
  const backupCommit = s.chain.slices.find((entry) => entry.backup)
  assert.ok(backupCommit, 'committed as backups')
  const manifest = JSON.parse(await readFile(join(s.context.stateDir, EPOCH.toString(), 'slices-backup.json'), 'utf8')) as SliceManifestV1
  assert.deepEqual(
    manifest.slices.map((slice) => `${slice.targetKey}#${slice.sliceIndex}`).sort(),
    backedUp.map((slice) => `${slice.targetKey}#${slice.sliceIndex}`).sort(),
  )
})

test('a backup collector waits for unreachable primary files, not for ones that never match', async (t) => {
  const pick = async (): Promise<Setup> => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const candidate = await setup({ others: 2 })
      t.after(() => rm(candidate.dir, { recursive: true, force: true }))
      if (candidate.plan.slices.some((slice) => slice.backup === candidate.me && slice.owner !== candidate.me)) return candidate
    }
    throw new Error('no fixture with backed-up slices')
  }
  const primaryFrom = (s: Setup, uri: string, hash: string): CommitmentEvent => {
    const owner = s.plan.slices.find((slice) => slice.backup === s.me && slice.owner !== s.me)!.owner
    return { epoch: EPOCH, hash, uri, backup: false, sender: getAddress(owner), blockNumber: 1, logIndex: 0, txHash: '0x' }
  }

  // Bytes that never match their commitment: invalid at once, the backups are bought right away.
  const s = await pick()
  const stored = await s.storage.put(Buffer.from('{"kind":"antseed-kbf-slices"}'))
  s.chain.time = START + COLLECT_SECONDS + 60
  s.chain.slices.push(primaryFrom(s, stored, `0x${'12'.repeat(32)}`))
  await verifierTick(s.context)
  assert.ok(s.chain.slices.some((entry) => entry.backup), 'mismatched delivery: backups bought at once')

  // A committed file the store cannot serve right now: wait before buying backups.
  const u = await pick()
  u.chain.time = START + COLLECT_SECONDS + 60
  u.chain.slices.push(primaryFrom(u, `ipfs://local-${'0'.repeat(64)}`, `0x${'34'.repeat(32)}`))
  await assert.rejects(verifierTick(u.context), /unavailable; retrying/)
  assert.equal(u.requests.length, 0)
  u.chain.time = START + COLLECT_SECONDS + 7 * 3600
  await verifierTick(u.context)
  assert.ok(u.chain.slices.some((entry) => entry.backup), 'after the wait the unreachable slices are bought as backups')
  assert.ok(u.logs.some((line) => line.includes('still unavailable')))
})

test('format adaptations do not use up a batch attempt', async () => {
  const me = new Wallet(Wallet.createRandom().privateKey)
  const seller = new Wallet(Wallet.createRandom().privateKey)
  const target: RoundTargetV1 = {
    agentId: '1', peerId: seller.address.slice(2).toLowerCase(), service: MODEL, serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH,
  }
  const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: EPOCH.toString(), models: { [MODEL]: referenceFixture(MODEL, 40) } }
  const plan = derivePlan({ epoch: EPOCH.toString(), seed: SEED, probesPerService: 10, slicesPerService: 1, verifiers: [me.address], targets: [target], bank })
  const slice = envelopeFor(plan, bank, me.address, { backup: false }).slices[0]!
  const { collectSlice } = await import('./collector.js')
  const answers = [
    () => new Response('temperature is not supported by this model', { status: 400 }),
    () => new Response('reasoning_effort is not supported', { status: 400 }),
    () => { throw new Error('socket hang up') },
    () => { throw new Error('socket hang up') },
    () => { throw new Error('socket hang up') },
  ]
  let calls = 0
  const fetchImpl = (async () => answers[calls++]!()) as unknown as typeof fetch
  const collected = await collectSlice({ ...slice, batches: slice.batches.slice(0, 1) }, {
    buyerUrl: 'http://buyer.test', responseAuth: {} as ResponseAuthReader, log: () => {}, fetchImpl, affordable: async (targets) => targets,
  })
  assert.equal(calls, 5, 'two format adaptations, then all three attempts at an answer')
  assert.equal(collected.exchanges.length, 0)
})

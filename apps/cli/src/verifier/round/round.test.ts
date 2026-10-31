import assert from 'node:assert/strict'
import test from 'node:test'
import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { canonicalJsonStringify, type KbfProbe } from '@antseed/fingerprints'
import { createResponseAuthPayload, encodeHttpRequest, encodeHttpResponse } from '@antseed/node'
import { buildKbfProbeRequestBody } from '../model-run.js'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { derivePlan, envelopeFor } from './plan.js'
import { ResultsTree, collectorLeaf, serviceLeaf, verifyProof } from './merkle.js'
import { scoreRound, type CommittedManifest } from './scoring.js'
import { SeededStream, seededRanking, seededShuffle } from './seeded.js'
import {
  bankKeyHash,
  generateEncryptionKeyPair,
  openBank,
  openEnvelope,
  sealBank,
  sealEnvelope,
} from './sealing.js'
import {
  targetKey,
  type EpochBankV1,
  type PlannedSliceV1,
  type RoundPlanV1,
  type RoundTargetV1,
  type SliceExchangeV1,
  type SliceManifestV1,
} from './types.js'

const SEED = `0x${'ab'.repeat(32)}`
const MODEL = 'model-a'
const wallet = () => new Wallet(Wallet.createRandom().privateKey)
const verifiers = [wallet(), wallet(), wallet()]
const honest = wallet()
const cheater = wallet()

function bank(): EpochBankV1 {
  return { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: '7', models: { [MODEL]: referenceFixture(MODEL, 40) } }
}

function target(agentId: string, seller: Wallet): RoundTargetV1 {
  return {
    agentId,
    peerId: seller.address.slice(2).toLowerCase(),
    service: MODEL,
    serviceHash: keccak256(toUtf8Bytes(MODEL)),
    model: MODEL,
    modelHash: keccak256(toUtf8Bytes(MODEL)),
  }
}

function plan(): RoundPlanV1 {
  return derivePlan({
    epoch: '7',
    seed: SEED,
    probesPerService: 20,
    slicesPerService: 2,
    verifiers: verifiers.map((wallet) => wallet.address),
    targets: [target('2', cheater), target('1', honest)],
    bank: bank(),
  })
}

/** Signed seller answers for one planned slice; `offset` shifts every answer away from consensus. */
function deliver(slice: PlannedSliceV1, roundPlan: RoundPlanV1, seller: Wallet, offset: number, buyer: Wallet): SliceExchangeV1[] {
  const reference = bank().models[MODEL]!
  const probesById = new Map(reference.probes.map((probe) => [probe.id, probe]))
  const roundTarget = roundPlan.targets.find((entry) => targetKey(entry) === slice.targetKey)!
  return slice.batches.map((batch) => {
    const probes = batch.probeIds.map((id) => probesById.get(id)!) as KbfProbe[]
    const requestId = crypto.randomUUID()
    const body = buildKbfProbeRequestBody(roundTarget.service, reference.queryProfile, probes, batch.promptVariantId)
    const headers = { 'content-type': 'application/json' }
    const content = probes.map((probe, index) => `(${index + 1}) ${probe.consensus + offset}`).join('\n')
    const responseBody = new TextEncoder().encode(JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] }))
    const request = { requestId, method: 'POST', path: '/v1/chat/completions', headers, body }
    const response = { requestId, statusCode: 200, headers, body: responseBody }
    const auth = createResponseAuthPayload({
      request, response, buyerPeerId: buyer.address, sellerPeerId: roundTarget.peerId,
      advertisedService: roundTarget.service, provider: 'openai', responseStartedAt: 1, responseCompletedAt: 2,
    }, seller)
    return {
      batchIndex: batch.batchIndex,
      requestId,
      responseAuth: auth,
      requestBase64: Buffer.from(encodeHttpRequest(request)).toString('base64'),
      responseBase64: Buffer.from(encodeHttpResponse(response)).toString('base64'),
    }
  })
}

function manifestsFor(roundPlan: RoundPlanV1, skip: (slice: PlannedSliceV1) => boolean = () => false): CommittedManifest[] {
  const bySeller = new Map([[targetKey(target('1', honest)), { seller: honest, offset: 0 }], [targetKey(target('2', cheater)), { seller: cheater, offset: 500 }]])
  const out: CommittedManifest[] = []
  for (const verifier of verifiers) {
    const collector = verifier.address.toLowerCase()
    const slices = roundPlan.slices.filter((slice) => slice.owner === collector && !skip(slice)).map((slice) => {
      const { seller, offset } = bySeller.get(slice.targetKey)!
      return { targetKey: slice.targetKey, sliceIndex: slice.sliceIndex, exchanges: deliver(slice, roundPlan, seller, offset, verifier) }
    })
    if (slices.length === 0) continue
    const manifest: SliceManifestV1 = { kind: 'antseed-kbf-slices', version: 1, epoch: '7', collector, backup: false, slices }
    out.push({ collector, backup: false, uri: `ipfs://${collector}`, manifest })
  }
  return out
}

test('seeded draws are deterministic and label-separated', () => {
  const a = new SeededStream(SEED, 'x')
  const b = new SeededStream(SEED, 'x')
  assert.deepEqual([a.below(1000), a.below(1000)], [b.below(1000), b.below(1000)])
  assert.notDeepEqual(seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], SEED, 'one'), seededShuffle([1, 2, 3, 4, 5, 6, 7, 8], SEED, 'two'))
  const ranking = seededRanking(['0xAA', '0xbb', '0xcc'], SEED, 'slice')
  assert.deepEqual(ranking, seededRanking(['0xcc', '0xbb', '0xaa'], SEED, 'slice'), 'order of input does not matter')
})

test('the plan is deterministic, covers every batch once and never assigns a seller to itself', () => {
  const first = plan()
  assert.deepEqual(first, plan())
  assert.deepEqual(first.targets.map((entry) => entry.agentId), ['1', '2'], 'targets in canonical order')
  for (const roundTarget of first.targets) {
    const key = targetKey(roundTarget)
    const probes = first.targetProbes[key]!
    assert.equal(probes.length, 20)
    const sliced = first.slices.filter((slice) => slice.targetKey === key).flatMap((slice) => slice.batches.flatMap((batch) => batch.probeIds))
    assert.deepEqual([...sliced].sort(), [...probes].sort())
  }
  const selfAudit = derivePlan({
    epoch: '7', seed: SEED, probesPerService: 20, slicesPerService: 2,
    verifiers: [honest.address, verifiers[0]!.address], targets: [target('1', honest)], bank: bank(),
  })
  assert.ok(selfAudit.slices.every((slice) => slice.owner === verifiers[0]!.address.toLowerCase()))
})

test('envelopes carry questions but no answers, and only the recipient can open them', () => {
  const roundPlan = plan()
  const owner = roundPlan.slices[0]!.owner
  const content = envelopeFor(roundPlan, bank(), owner, { backup: false })
  assert.ok(content.slices.length > 0)
  for (const slice of content.slices) {
    for (const batch of slice.batches) assert.ok(batch.probes.every((probe) => probe.consensus === 0))
  }
  const keys = generateEncryptionKeyPair()
  const sealed = sealEnvelope(keys.publicKey, Buffer.from(canonicalJsonStringify(content)))
  assert.deepEqual(JSON.parse(openEnvelope(keys.privateKey, sealed).toString('utf8')), JSON.parse(canonicalJsonStringify(content)))
  assert.throws(() => openEnvelope(generateEncryptionKeyPair().privateKey, sealed))
})

test('the sealed bank opens only with its key, whose hash matches abi.encode(bytes32)', () => {
  const plaintext = Buffer.from(canonicalJsonStringify(bank()))
  const sealed = sealBank(plaintext)
  assert.deepEqual(openBank(sealed.key, sealed.blob), plaintext)
  assert.throws(() => openBank(`0x${'11'.repeat(32)}`, sealed.blob))
  assert.equal(bankKeyHash(sealed.key), keccak256(sealed.key))
})

test('results trees prove every leaf and do not depend on leaf order', () => {
  const leaves = [
    serviceLeaf(7n, { agentId: 1n, serviceHash: SEED, modelHash: SEED, verdict: 'SAME' }),
    serviceLeaf(7n, { agentId: 2n, serviceHash: SEED, modelHash: SEED, verdict: 'DIFF' }),
    collectorLeaf(7n, verifiers[0]!.address, 3, 4),
  ]
  const tree = new ResultsTree(leaves)
  assert.equal(tree.root, new ResultsTree([...leaves].reverse()).root)
  for (const leaf of leaves) assert.ok(verifyProof(tree.root, leaf, tree.proof(leaf)))
})

test('scoring finds the honest seller SAME and the cheater DIFF, identically for every verifier', () => {
  const roundPlan = plan()
  const manifests = manifestsFor(roundPlan)
  const results = scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests })
  const verdicts = Object.fromEntries(results.results.map((result) => [result.target.agentId, result.verdict]))
  assert.deepEqual(verdicts, { '1': 'SAME', '2': 'DIFF' })
  assert.equal(results.totalSlices, roundPlan.slices.length)
  assert.equal(results.root, scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests: [...manifests].reverse() }).root)
})

test('a missing slice makes the target UNDETERMINED, never SAME', () => {
  const roundPlan = plan()
  const dropped = roundPlan.slices.find((slice) => slice.targetKey === targetKey(target('1', honest)))!
  const results = scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests: manifestsFor(roundPlan, (slice) => slice === dropped) })
  const honestResult = results.results.find((result) => result.target.agentId === '1')!
  assert.equal(honestResult.verdict, 'UNDETERMINED')
  assert.match(honestResult.reason, /slices missing/)
})

test('an edited answer breaks the seller signature and the slice is not used', () => {
  const roundPlan = plan()
  const manifests = manifestsFor(roundPlan)
  const cheaterKey = targetKey(target('2', cheater))
  const tampered = manifests.find((entry) => entry.manifest.slices.some((slice) => slice.targetKey === cheaterKey))!
  const slice = tampered.manifest.slices.find((entry) => entry.targetKey === cheaterKey)!
  const exchange = slice.exchanges[0]!
  const honestTwin = deliver(roundPlan.slices.find((entry) => entry.targetKey === cheaterKey && entry.sliceIndex === slice.sliceIndex)!, roundPlan, honest, 0, verifiers[0]!)[0]!
  exchange.responseBase64 = honestTwin.responseBase64
  const results = scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests })
  assert.equal(results.results.find((result) => result.target.agentId === '2')!.verdict, 'UNDETERMINED')
})

test('a backup delivery fills a slice its owner did not deliver', () => {
  const roundPlan = plan()
  const dropped = roundPlan.slices[0]!
  const manifests = manifestsFor(roundPlan, (slice) => slice === dropped)
  const seller = dropped.targetKey === targetKey(target('1', honest)) ? honest : cheater
  const offset = seller === honest ? 0 : 500
  const backupWallet = verifiers.find((entry) => entry.address.toLowerCase() === dropped.backup)!
  manifests.push({
    collector: dropped.backup,
    backup: true,
    uri: 'ipfs://backup',
    manifest: {
      kind: 'antseed-kbf-slices', version: 1, epoch: '7', collector: dropped.backup, backup: true,
      slices: [{ targetKey: dropped.targetKey, sliceIndex: dropped.sliceIndex, exchanges: deliver(dropped, roundPlan, seller, offset, backupWallet) }],
    },
  })
  const results = scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests })
  assert.deepEqual(results.results.map((result) => result.verdict), ['SAME', 'DIFF'])
  assert.ok(results.results.some((result) => result.sources.some((source) => source.manifestUri === 'ipfs://backup')))
})

test('a slice from someone who is neither its owner nor its backup is ignored', () => {
  const roundPlan = plan()
  const slice = roundPlan.slices[0]!
  const outsider = verifiers.find((entry) => ![slice.owner, slice.backup].includes(entry.address.toLowerCase()))
  if (!outsider) return
  const manifests = manifestsFor(roundPlan, (entry) => entry === slice)
  const seller = slice.targetKey === targetKey(target('1', honest)) ? honest : cheater
  manifests.push({
    collector: outsider.address.toLowerCase(), backup: false, uri: 'ipfs://outsider',
    manifest: {
      kind: 'antseed-kbf-slices', version: 1, epoch: '7', collector: outsider.address.toLowerCase(), backup: false,
      slices: [{ targetKey: slice.targetKey, sliceIndex: slice.sliceIndex, exchanges: deliver(slice, roundPlan, seller, 0, outsider) }],
    },
  })
  const results = scoreRound({ epoch: 7n, plan: roundPlan, bank: bank(), manifests })
  assert.equal(results.results.find((result) => targetKey(result.target) === slice.targetKey)!.verdict, 'UNDETERMINED')
})

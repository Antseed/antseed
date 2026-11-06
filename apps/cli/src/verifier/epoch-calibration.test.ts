import assert from 'node:assert/strict'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  KBF_CALIBRATION_METHOD,
  KBF_PROMPT_VARIANT_IDS,
  clopperPearsonUpper,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  renderKbfProbeLine,
  verifyKbf,
  type KbfProbe,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { setAuditedModelsForTesting } from './audited-models.js'
import { calibrateEpochQuestionSet, ensureEpochQuestionSet } from './ensure-auditable-reference.js'
import { kbfAuditBatches } from './kbf-batching.js'
import { calibrateReferenceSets } from './model-reference.js'
import {
  appendModelReferenceToBank,
  bankPath,
  epochQuestionSetPath,
  loadBankReferenceExchanges,
  loadEpochQuestionSet,
  NO_EPOCH_QUESTION_SET,
  recordEpochQuestionPool,
  recordEpochSetCalibration,
  reserveExtensionReference,
  reserveModelAuditReference,
  selectEpochQuestionSet,
  type EpochQuestionSetV1,
} from './probe-bank.js'

setAuditedModelsForTesting({ 'model-a': { upstreamModel: 'upstream-a', contrastModels: [] } })

const SOURCE_ID = 'reference-source'
const EPOCH = '12'
const MAX_TOKENS = 2_400

const config: VerifierCLIConfig = {
  referenceRetryBaseDelayMs: 1,
  referenceBatchRetryCount: 0,
  models: { 'model-a': { pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
  referenceEndpoint: { baseUrl: 'https://reference.test/v1', sourceId: SOURCE_ID, trust: 'trusted' },
}

/** 690 probes over 15 domains, whose enrollment self-test missed `selfMisses` of each 100 trials. */
function bankedReference(selfMisses = 12): KbfReferenceV1 {
  const count = 690
  const probes: KbfProbe[] = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index}`,
    name: `question ${index}`,
    domain: `domain-${index % 15}`,
    template: `The value of question ${index} is ___.`,
    consensus: 1_000 + index,
    range: [0, 100_000],
    tolerance: { mode: 'absolute', value: 0 },
  }))
  const outcomes = probes.map((probe, index) => {
    const miss = index % 100 < selfMisses
    return { probeId: probe.id, answers: [miss ? probe.consensus + 5 : probe.consensus], matches: [miss ? 0 as const : 1 as const] }
  })
  const hamming = outcomes.filter((outcome) => outcome.matches[0] === 0).length
  const power = computeBinomialPower({
    selfHamming: hamming, selfTotal: count, probeCount: count, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  const value: KbfReferenceV1 = {
    version: 2,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'model-a',
    serviceAliases: ['model-a'],
    createdAt: '2026-11-05T00:00:00.000Z',
    source: 'generated',
    generator: {
      name: 'antseed-simple-reference-builder', version: '7', verifierKind: 'kbf',
      params: {
        selfTestRuns: 1,
        referenceProvider: { pinned: { order: ['provider-a'], allowFallbacks: false }, served: ['Provider-A'] },
        referenceEndpointRequest: { reasoningStrategy: 'reasoning-effort-none', requestOverrides: { reasoning_effort: 'none' }, requestOmissions: [] },
      },
    },
    provenance: { sourceId: SOURCE_ID, trust: 'trusted' },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream-a', maxTokensPerRequest: MAX_TOKENS }),
    selfTest: { hamming, total: count, coverage: 1, errorRate: hamming / count, outcomes },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial', alpha: 0.05, clopperPearsonConfidence: 0.99, selfHamming: hamming, selfTotal: count,
      probeCount: count, p0UpperBound: power.p0, alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount, power: power.power,
    },
    contrasts: [{ model: 'contrast-a', distinguishingProbeIds: probes.map((probe) => probe.id) }],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

interface Sent {
  body: Record<string, unknown> & { messages: Array<{ role: string; content: string }> }
  values: number[]
}

type Reply = (values: number[], sent: Sent) => { content: string; finish?: string } | Response

const labelled = (values: number[]) => ({ content: values.map((value, index) => `(${index + 1}) ${value}`).join('\n') })

/** A reference endpoint: answers each asked question's label unless `reply` says otherwise. */
function endpoint(reply: Reply = labelled) {
  const sent: Sent[] = []
  const fetchFn = (async (_url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Sent['body']
    const prompt = body.messages.filter((message) => message.role === 'user').at(-1)!.content
    const values = [...prompt.matchAll(/value of question (\d+) is/g)].map((match) => 1_000 + Number(match[1]))
    const request = { body, values }
    sent.push(request)
    const replied = reply(values, request)
    if (replied instanceof Response) return replied
    return Response.json({
      provider: 'Provider-A',
      choices: [{ message: { content: replied.content }, finish_reason: replied.finish ?? 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
  }) as typeof fetch
  return { sent, fetchFn }
}

async function withSet(
  body: (input: { directory: string; set: EpochQuestionSetV1 }) => Promise<void>,
  selfMisses?: number,
) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-epoch-calibration-'))
  try {
    const appended = await appendModelReferenceToBank({
      banksDir: directory, model: 'model-a', reference: bankedReference(selfMisses),
      cost: { totalUsdMicros: '0', requestCount: 0, models: [], purposes: [] },
    })
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: EPOCH, probeIds: appended.addedProbeIds })
    const selection = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: EPOCH, runId: 'set-run', extensionCount: 2, shuffle: (values) => [...values],
    })
    if (selection.status !== 'ready') throw new Error(selection.reason)
    await body({ directory, set: selection.set })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

const operations = { catalog: async () => null, ask: calibrateReferenceSets, record: recordEpochSetCalibration }

function calibrate(
  directory: string, set: EpochQuestionSetV1, fetchFn: typeof fetch, maxRequests = 1_000, log?: (line: string) => void,
) {
  return calibrateEpochQuestionSet({
    model: 'model-a', banksDir: directory, config, maxRequests, epoch: EPOCH, set, fetchFn, ...(log ? { log } : {}),
  }, operations)
}

function questions(probes: readonly KbfProbe[]): string[] {
  return probes.map(renderKbfProbeLine)
}

test('calibration asks each batch of every set exactly as a seller gets it, with the bank\'s request settings', async () => withSet(async ({ directory, set }) => {
  const { sent, fetchFn } = endpoint()
  await calibrate(directory, set, fetchFn)
  const references = [set.reference, ...set.extensions]
  const expected = references.flatMap((reference) => kbfAuditBatches(reference.probes).map((batch) => questions(batch.probes)))
  assert.equal(sent.length, expected.length)
  const asked = sent.map(({ body }) => body.messages.filter((message) => message.role === 'user').at(-1)!.content)
  for (const batch of expected) {
    const prompt = asked.find((text) => batch.every((question) => text.includes(question)) && (text.match(/___/g)?.length ?? 0) - 1 <= batch.length)
    assert.ok(prompt, `batch starting "${batch[0]}" was not asked as one request`)
  }
  for (const { body } of sent) {
    assert.equal(body.temperature, 0)
    assert.equal(body.max_tokens, MAX_TOKENS)
    assert.equal(body.reasoning_effort, 'none')
    assert.deepEqual(body.provider, { order: ['provider-a'], allow_fallbacks: false })
    assert.equal(body.model, 'upstream-a')
    assert.equal('top_p' in body, false)
  }
  // Prompt variants vary per batch, as an audit's do.
  assert.ok(new Set(asked.map((text) => text.slice(0, 60))).size > 1)
}))

test('a calibrated set takes its limit from the calibration trials, not from the enrollment self-test', async () => withSet(async ({ directory, set }) => {
  const missed = new Set([1_001, 1_002, 1_003, 1_004, 1_005, 1_006])
  const { fetchFn } = endpoint((values) => labelled(values.map((value) => (missed.has(value) ? value + 5 : value))))
  const calibrated = await calibrate(directory, set, fetchFn)
  assert.equal(calibrated.calibration?.status, 'passed')
  assert.equal(calibrated.calibration?.passes, 1)
  const calibration = calibrated.reference.calibration!
  assert.equal(calibration.method, KBF_CALIBRATION_METHOD)
  assert.equal(calibration.hamming, 6)
  assert.equal(calibration.total, calibrated.reference.probes.length)
  // The same probes, the same enrollment self-test, a new id because the reference now holds its calibration.
  assert.notEqual(calibrated.reference.referenceId, set.reference.referenceId)
  assert.deepEqual(calibrated.reference.selfTest, set.reference.selfTest)
  assert.equal(calibrated.reference.statisticalPower, set.reference.statisticalPower)
  const judged = verifyKbf(calibrated.reference, { answers: calibrated.reference.probes.map((probe) => probe.consensus) })
  assert.equal(judged.stats.selfHamming, 6)
  assert.equal(judged.stats.selfTotal, calibration.total)
  assert.equal(judged.stats.p0Cp99, clopperPearsonUpper(6, calibration.total, 0.99))
  assert.notEqual(judged.stats.p0Cp99, verifyKbf(set.reference, { answers: set.reference.probes.map((probe) => probe.consensus) }).stats.p0Cp99)
  for (const batch of calibration.batches) assert.ok(KBF_PROMPT_VARIANT_IDS.includes(batch.promptVariantId as typeof KBF_PROMPT_VARIANT_IDS[number]))
  // Sellers now get the calibrated references, the extra sets too.
  const reserved = await reserveModelAuditReference({
    banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: EPOCH,
  })
  assert.equal(reserved.reference.referenceId, calibrated.reference.referenceId)
  const extra = await reserveExtensionReference({
    banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: EPOCH,
    probeCount: reserved.reference.probes.length,
  })
  assert.equal(extra.reference.calibration?.total, reserved.reference.probes.length)
}))

test('coverage under 80% on a set stops the model for the epoch, and nothing is asked again', async () => withSet(async ({ directory, set }) => {
  const firstSet = new Set(set.reference.probes.map((probe) => probe.consensus))
  const { sent, fetchFn } = endpoint((values) => (firstSet.has(values[0]!)
    ? { content: values.slice(0, Math.ceil(values.length * 0.6)).map((value, index) => `(${index + 1}) ${value}`).join('\n') }
    : labelled(values)))
  await assert.rejects(calibrate(directory, set, fetchFn), /failed calibration: the reference answered \d+\.\d% .*not audited this epoch/)
  const stored = await loadEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: EPOCH })
  assert.equal(stored?.calibration?.status, 'failed')
  assert.equal(stored?.reference.calibration, undefined)
  assert.equal(stored?.calibration?.failedCalibrations?.length, 3)
  await assert.rejects(reserveModelAuditReference({
    banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: EPOCH,
  }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}.*failed calibration`))
  const asked = sent.length
  await assert.rejects(calibrate(directory, stored!, fetchFn), /failed calibration/)
  assert.equal(sent.length, asked)
}))

test('a calibration rate above the enrollment limit warns, sets the limit and does not stop the model', async () => withSet(async ({ directory, set }) => {
  const { fetchFn } = endpoint((values) => labelled(values.map((value) => (value % 3 === 0 ? value + 5 : value))))
  const log: string[] = []
  const calibrated = await calibrate(directory, set, fetchFn, 1_000, (line) => log.push(line))
  assert.equal(calibrated.calibration?.status, 'passed')
  assert.ok(calibrated.calibration!.errorRate > calibrated.calibration!.enrollmentErrorLimit)
  assert.ok(calibrated.reference.calibration, 'the limit comes from the calibration')
  assert.ok(log.some((line) => /warning: .*may have changed since enrollment/.test(line)))
}))

test('an interrupted calibration resumes from its checkpoint without asking anything twice', async () => withSet(async ({ directory, set }) => {
  const asked = new Map<string, number>()
  const key = ({ body }: Sent) => JSON.stringify(body.messages)
  let answered = 0
  const flaky = endpoint((values, request) => {
    if (answered >= 20) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
    answered += 1
    asked.set(key(request), (asked.get(key(request)) ?? 0) + 1)
    return labelled(values)
  })
  await assert.rejects(calibrate(directory, set, flaky.fetchFn), /reference endpoint 401/)
  assert.equal(answered, 20)
  assert.equal((await loadEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: EPOCH }))?.calibration, undefined)

  const steady = endpoint((values, request) => {
    asked.set(key(request), (asked.get(key(request)) ?? 0) + 1)
    return labelled(values)
  })
  const calibrated = await calibrate(directory, set, steady.fetchFn)
  const total = [set.reference, ...set.extensions].reduce((sum, reference) => sum + kbfAuditBatches(reference.probes).length, 0)
  assert.equal(steady.sent.length, total - 20)
  assert.equal(calibrated.calibration?.requestCount, total)
  assert.deepEqual([...new Set(asked.values())], [1], 'no batch was paid for twice')
  await assert.rejects(access(`${epochQuestionSetPath(directory, 'model-a', EPOCH)}.calibration.json`), /ENOENT/)
}))

test('out of requests is not a finding: the next run continues where this one stopped', async () => withSet(async ({ directory, set }) => {
  const { sent, fetchFn } = endpoint()
  await assert.rejects(calibrate(directory, set, fetchFn, 25), /budget exhausted/)
  assert.equal(sent.length, 25)
  const calibrated = await calibrate(directory, set, fetchFn, 1_000)
  assert.equal(calibrated.calibration?.status, 'passed')
  assert.equal(sent.length, calibrated.calibration?.requestCount)
}))

test('a set that exists without a calibration gets one through ensureEpochQuestionSet, and only once', async () => withSet(async ({ directory }) => {
  const { sent, fetchFn } = endpoint()
  const ensure = () => ensureEpochQuestionSet({
    model: 'model-a', banksDir: directory, referencesDir: join(directory, 'references'), config, maxRequests: 1_000,
    epoch: EPOCH, runId: 'run-b', extensionCount: 2,
  }, {
    inspect: async () => ({ totalProbeCount: 690, eligibleProbeCount: 690, selectedProbeCount: null, statisticalPower: null }),
    select: selectEpochQuestionSet,
    enrollFresh: async () => { throw new Error('must not build') },
    record: recordEpochQuestionPool,
    calibrate: (input) => calibrateEpochQuestionSet({ ...input, fetchFn }, operations),
  })
  const first = await ensure()
  assert.equal(first.calibration?.status, 'passed')
  const asked = sent.length
  assert.ok(asked > 0)
  const second = await ensure()
  assert.equal(second.reference.referenceId, first.reference.referenceId)
  assert.equal(sent.length, asked)
}))

test('a reference batch is treated like a seller\'s: think blocks stripped, cut-off replies unscored, missing answers re-asked', async () => withSet(async ({ directory, set }) => {
  const [first, second, third] = kbfAuditBatches(set.reference.probes)
  const startsWith = (values: number[], probes: readonly KbfProbe[]) => values[0] === probes[0]!.consensus
  const attempts = new Map<string, number>()
  const { sent, fetchFn } = endpoint((values) => {
    const key = String(values[0])
    const attempt = (attempts.get(key) ?? 0) + 1
    attempts.set(key, attempt)
    if (startsWith(values, first!.probes)) {
      // Worked-out numbers in a think block are not answers.
      return { content: `${labelled(values).content}\n<think>\n(1) 1\n(2) 2\n</think>` }
    }
    if (startsWith(values, second!.probes)) {
      // One answer short, then cut off, then the fullest reply again: at most three asks, fullest kept.
      if (attempt === 1) return { content: values.slice(1).map((value, index) => `(${index + 2}) ${value}`).join('\n') }
      return { content: labelled(values.map((value) => value + 1)).content, finish: 'length' }
    }
    if (startsWith(values, third!.probes)) return { content: '', finish: 'content_filter' }
    return labelled(values)
  })
  const calibrated = await calibrate(directory, set, fetchFn)
  const calibration = calibrated.reference.calibration!
  const outcome = (probe: KbfProbe) => calibration.outcomes.find((entry) => entry.probeId === probe.id)!
  assert.deepEqual(first!.probes.map((probe) => outcome(probe).matches[0]), first!.probes.map(() => 1))
  assert.equal(outcome(second!.probes[0]!).answers[0], null)
  assert.equal(outcome(second!.probes[1]!).answers[0], second!.probes[1]!.consensus)
  const batches = calibration.batches
  assert.equal(batches[0]!.attempts, 1)
  assert.equal(batches[1]!.attempts, 3)
  assert.equal(batches[1]!.truncated, undefined, 'the kept attempt was not the cut-off one')
  assert.equal(batches[2]!.attempts, 3)
  assert.equal(outcome(third!.probes[0]!).answers[0], null)
  assert.equal(sent.filter(({ values }) => values[0] === second!.probes[0]!.consensus).length, 3)
}, 25))

test('calibration publishes its raw exchanges with the bank, and a third party can recompute the limit', async () => withSet(async ({ directory, set }) => {
  const { sent, fetchFn } = endpoint()
  const calibrated = await calibrate(directory, set, fetchFn)
  const exchanges = await loadBankReferenceExchanges(directory, 'model-a')
  const stored = exchanges.find((entry) => entry.referenceId === calibrated.reference.referenceId)!
  assert.equal(stored.exchangeCount, sent.length)
  const file = JSON.parse(await readFile(stored.absolutePath, 'utf8')) as { exchanges: Array<{ purpose: string; requestBody: string; responseBody: string }> }
  assert.equal(file.exchanges.length, sent.length)
  assert.equal(file.exchanges.every((exchange) => exchange.purpose === 'calibration'), true)
  const bank = JSON.parse(await readFile(bankPath(directory, 'model-a'), 'utf8')) as { referenceExchanges: unknown[] }
  assert.equal(bank.referenceExchanges.length, 1)
}))

test('calibration refuses another endpoint or provider than the bank was enrolled on', async () => withSet(async ({ directory, set }) => {
  const { sent, fetchFn } = endpoint()
  const ask = (value: VerifierCLIConfig) => calibrateEpochQuestionSet({
    model: 'model-a', banksDir: directory, config: value, maxRequests: 100, epoch: EPOCH, set, fetchFn,
  }, operations)
  await assert.rejects(ask({ ...config, referenceEndpoint: { ...config.referenceEndpoint!, sourceId: 'other-source' } }), /was enrolled on reference-source/)
  await assert.rejects(ask({
    ...config, models: { 'model-a': { ...config.models!['model-a']!, referenceProvider: { order: ['provider-b'] } } },
  }), /another provider/)
  assert.equal(sent.length, 0)
}))

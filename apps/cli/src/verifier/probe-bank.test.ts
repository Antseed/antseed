import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  KBF_CALIBRATION_METHOD,
  aggregateKbfSelfTestOutcomes,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  queryProfileHash,
  type KbfReferenceCalibrationV1,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { setAuditedModelsForTesting } from './audited-models.js'
import { kbfAuditBatches } from './kbf-batching.js'
import {
  appendModelReferenceToBank,
  EPOCH_QUESTION_SET_METHOD,
  epochBankPath,
  epochQuestionSetPath,
  findEpochProbeReference,
  findEpochQuestionSetByReferenceId,
  loadBankEnrollmentReference,
  loadBankReferenceExchanges,
  loadEpochQuestionSet,
  loadModelAuditReservation,
  missingBankReferenceExchanges,
  NO_EPOCH_QUESTION_SET,
  recordEpochQuestionPool,
  recordEpochSetCalibration,
  reserveExtensionReference,
  reserveModelAuditReference,
  isRetiredEpochQuestionSetReference,
  retireEpochQuestionSet,
  selectEpochQuestionSet,
  sellerLedgerPath,
  voidModelAuditReference,
  type EpochQuestionSetV1,
} from './probe-bank.js'

const referenceCost = {
  totalUsdMicros: '1250000',
  requestCount: 2,
  models: [{
    model: 'model-a', requestCount: 2, inputTokens: 100, outputTokens: 50,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, costUsdMicros: '1250000',
  }],
  purposes: [{
    purpose: 'target-model' as const,
    model: 'model-a', requestCount: 2, inputTokens: 100, outputTokens: 50,
    inputUsdPerMillion: 1, outputUsdPerMillion: 2, costUsdMicros: '1250000',
  }],
}

/** Banks `value` in `epoch`'s bank. */
function appendReference(banksDir: string, value = reference(), epoch = '4') {
  return appendModelReferenceToBank({ banksDir, model: 'model-a', epoch, reference: value, cost: referenceCost })
}

const identityShuffle = <T>(values: readonly T[]) => [...values]

/** One pass in which the reference gives every label. */
function cleanCalibration(value: KbfReferenceV1): KbfReferenceCalibrationV1 {
  const outcomes = value.probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1 as const] }))
  return {
    version: 1,
    method: KBF_CALIBRATION_METHOD,
    passes: 1,
    ...aggregateKbfSelfTestOutcomes(outcomes),
    batches: kbfAuditBatches(value.probes).map((batch, batchIndex) => ({
      pass: 0, batchIndex, probeIds: batch.probes.map((probe) => probe.id), promptVariantId: 'v1', attempts: 1,
    })),
    calibratedAt: '2026-08-06T00:00:00.000Z',
  }
}

async function calibrate(banksDir: string, epoch: string, set: EpochQuestionSetV1, config?: VerifierCLIConfig): Promise<EpochQuestionSetV1> {
  const path = join(banksDir, 'calibration.exchanges.json')
  await writeFile(path, '{}')
  return recordEpochSetCalibration({
    banksDir, model: 'model-a', epoch, config, passes: 1, cost: referenceCost,
    calibrations: [set.reference, ...set.extensions].map(cleanCalibration),
    exchanges: {
      path, sha256: 'sha256:00', exchangeCount: 1, requestCount: 1,
      upstream: { name: 'referenceEndpoint', type: 'openai', baseUrl: 'https://reference.test/v1', model: 'upstream-a', protocol: 'openai-chat-completions', request: { overrides: {}, omissions: [] }, providerPin: null },
    },
  })
}

/** Selects `epoch`'s question set from every question of its bank, in bank order. */
async function selectAll(
  banksDir: string,
  epoch: string,
  options: { config?: VerifierCLIConfig; extensionCount?: number } = {},
) {
  const bank = JSON.parse(await readFile(epochBankPath(banksDir, 'model-a', epoch), 'utf8')) as { probes: Array<{ probe: { id: string } }> }
  await recordEpochQuestionPool({ banksDir, model: 'model-a', epoch, probeIds: bank.probes.map((entry) => entry.probe.id) })
  return selectEpochQuestionSet({
    banksDir, model: 'model-a', epoch, runId: 'set-run', extensionCount: options.extensionCount ?? 0,
    config: options.config, shuffle: identityShuffle,
  })
}

/** Makes `epoch`'s question set from every question of its bank, in bank order, and calibrates it. */
async function makeSet(
  banksDir: string,
  epoch: string,
  options: { config?: VerifierCLIConfig; extensionCount?: number } = {},
): Promise<EpochQuestionSetV1> {
  const selection = await selectAll(banksDir, epoch, options)
  if (selection.status !== 'ready') throw new Error(`no set: ${selection.reason}`)
  return calibrate(banksDir, epoch, selection.set, options.config)
}

setAuditedModelsForTesting({
  'model-a': { upstreamModel: 'upstream-a', contrastModels: [] },
  'different-model': { upstreamModel: 'upstream-b', contrastModels: [] },
})

function excludedDomainConfig(model = 'model-a'): VerifierCLIConfig {
  return {
    referenceEndpoint: {
      baseUrl: 'https://reference.test/v1',
      sourceId: 'test',
      trust: 'trusted',
    },
    models: {
      [model]: {
        contrastModels: ['contrast-a'],
        excludedDomains: ['medical'],
      },
    },
  }
}

function reference(count = 200): KbfReferenceV1 {
  const probes = Array.from({ length: count }, (_, index) => ({
    id: `probe-${index + 1}`,
    name: `probe ${index + 1}`,
    domain: 'test',
    template: `The test value ${index + 1} is ___.`,
    consensus: index + 1,
    range: [0, count + 1] as [number, number],
    tolerance: { mode: 'absolute' as const, value: 0 },
  }))
  const power = computeBinomialPower({
    selfHamming: 0, selfTotal: count, probeCount: count, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  const value: KbfReferenceV1 = {
    version: 2,
    kind: 'kbf',
    referenceId: '',
    referenceModel: 'model-a',
    serviceAliases: ['model-a'],
    createdAt: '2026-08-06T00:00:00.000Z',
    source: 'generated',
    generator: { name: 'test', version: '1', verifierKind: 'kbf', params: {} },
    provenance: { sourceId: 'trusted', trust: 'trusted' },
    queryProfile: createReferenceQueryProfile({ upstreamModel: 'upstream-a' }),
    selfTest: {
      hamming: 0,
      total: count,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answers: [probe.consensus], matches: [1] })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial', alpha: 0.05, clopperPearsonConfidence: 0.99,
      selfHamming: 0, selfTotal: count, probeCount: count, p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [{ model: 'contrast-a', distinguishingProbeIds: probes.map((probe) => probe.id) }],
  }
  value.referenceId = computeReferenceId(value)
  return value
}

/** A reference whose probes come after the first `offset` probes of `reference()`. */
function shiftedReference(count: number, offset: number): KbfReferenceV1 {
  const value = reference(count + offset)
  const keep = new Set(value.probes.slice(offset).map((probe) => probe.id))
  value.probes = value.probes.slice(offset)
  value.selfTest.outcomes = value.selfTest.outcomes.filter((outcome) => keep.has(outcome.probeId))
  value.selfTest.total = count
  value.selectedProbeCount = count
  const power = computeBinomialPower({
    selfHamming: 0, selfTotal: count, probeCount: count, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  value.statisticalPower = power.power
  value.statisticalPowerEvidence = {
    ...value.statisticalPowerEvidence, selfTotal: count, probeCount: count, p0UpperBound: power.p0,
    alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount, power: power.power,
  }
  value.contrasts = [{ model: 'contrast-a', distinguishingProbeIds: [...keep] }]
  value.referenceId = computeReferenceId(value)
  return value
}

test('probe banks append, deduplicate, and discard conflicting canonical variants', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    const first = await appendReference(directory)
    assert.equal(first.addedProbeCount, 200)
    const second = await appendReference(directory)
    assert.equal(second.addedProbeCount, 0)
    assert.equal(second.totalProbeCount, 200)

    const conflicting = reference()
    conflicting.probes[0]!.template = 'Conflicting value is ___.'
    conflicting.referenceId = computeReferenceId(conflicting)
    const discarded = await appendReference(directory, conflicting)
    assert.equal(discarded.addedProbeCount, 0)
    assert.equal(discarded.canonicalConflictProbeCount, 1)
    const bank = JSON.parse(await readFile(discarded.path, 'utf8')) as {
      probes: Array<{ probe: KbfReferenceV1['probes'][number] }>
    }
    assert.equal(bank.probes[0]!.probe.template, 'The test value 1 is ___.')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a bank of any size gives a valid settings seed for enrollment', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    // 175 probes are not a whole number of batches, as when a bank is split between auditors.
    const oddDir = join(directory, 'odd')
    const odd = await appendReference(oddDir, reference(180))
    const bank = JSON.parse(await readFile(odd.path, 'utf8')) as { probes: unknown[] }
    bank.probes = bank.probes.slice(0, 175)
    await writeFile(odd.path, JSON.stringify(bank))
    assert.equal((await loadBankEnrollmentReference(oddDir, 'model-a', '4'))?.probes.length, 170)

    // 760 probes are more than one reference may hold.
    const largeDir = join(directory, 'large')
    await appendReference(largeDir, reference(380))
    await appendReference(largeDir, shiftedReference(380, 380))
    const seed = await loadBankEnrollmentReference(largeDir, 'model-a', '4')
    assert.equal(seed?.selectedProbeCount, 750)
    assert.equal(seed?.probes.length, 750)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('missing reference evidence of a bank is reported before a run', async () => {
  // A bank copied without reference-evidence/ would fail every submission after the run.
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    const appended = await appendReference(directory, reference(), '9')
    const bank = JSON.parse(await readFile(appended.path, 'utf8')) as { referenceExchanges?: Array<Record<string, unknown>> }
    const entry = { sha256: 'sha256:00', upstream: null, exchangeCount: 1, requestCount: 1 }
    bank.referenceExchanges = [
      { ...entry, referenceId: 'sha256:aa', path: 'reference-evidence/sha256:aa.exchanges.json' },
      { ...entry, referenceId: 'sha256:bb', path: 'reference-evidence/sha256:bb.exchanges.json' },
    ]
    await writeFile(appended.path, JSON.stringify(bank))
    await mkdir(join(dirname(appended.path), 'reference-evidence'), { recursive: true })
    await writeFile(join(dirname(appended.path), 'reference-evidence', 'sha256:aa.exchanges.json'), '{}')
    assert.deepEqual(await missingBankReferenceExchanges(directory, 'model-a', '9'), ['reference-evidence/sha256:bb.exchanges.json'])
    // Another epoch has its own bank, without these files.
    assert.deepEqual(await missingBankReferenceExchanges(directory, 'model-a', '10'), [])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

function noisyReference(count: number, wrongOutOfFive: number): KbfReferenceV1 {
  const value = reference(count)
  value.selfTest.outcomes = value.probes.map((probe, index) => {
    const answers = [0, 1, 2].map((run) => ((index * 3 + run) % 5 < wrongOutOfFive
      ? Number(probe.consensus) + 1
      : Number(probe.consensus)))
    return { probeId: probe.id, answers, matches: answers.map((answer) => (answer === probe.consensus ? 1 : 0)) }
  })
  const hamming = value.selfTest.outcomes.reduce(
    (sum, outcome) => sum + outcome.matches.filter((match) => match === 0).length, 0)
  value.selfTest = { ...value.selfTest, hamming, total: count * 3, coverage: 1, errorRate: hamming / (count * 3) }
  const power = computeBinomialPower({
    selfHamming: hamming, selfTotal: count * 3, probeCount: count,
    minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  value.statisticalPower = power.power
  value.statisticalPowerEvidence = {
    ...value.statisticalPowerEvidence,
    selfHamming: hamming, selfTotal: count * 3, probeCount: count, p0UpperBound: power.p0,
    alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount, power: power.power,
  }
  value.referenceId = computeReferenceId(value)
  return value
}

test('a reference that disagrees with itself up to half the time is still usable for audits', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-noisy-'))
  try {
    // 40% self-test disagreement: above the old 0.35 cutoff, below the 0.5 one.
    await appendReference(directory, noisyReference(500, 2))
    const noisy = await selectAll(directory, '4')
    assert.equal(noisy.status, 'ready')
    assert.ok(noisy.status === 'ready' && noisy.set.reference.statisticalPower >= 0.9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const broken = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-broken-'))
  try {
    // 60% self-test disagreement: treated as a broken reference.
    await appendReference(broken, noisyReference(500, 3))
    assert.equal((await selectAll(broken, '4')).status, 'short')
  } finally {
    await rm(broken, { recursive: true, force: true })
  }
})

test('excluded domains are left out of question sets and audit reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-domains-'))
  try {
    const mixed = reference()
    for (const [index, probe] of mixed.probes.entries()) probe.domain = index < 80 ? 'medical' : 'biology'
    mixed.referenceId = computeReferenceId(mixed)
    await appendReference(directory, mixed, 'filtered')
    await appendReference(directory, mixed, 'unfiltered')

    const config = excludedDomainConfig()
    await makeSet(directory, 'filtered', { config })
    assert.equal((await loadEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: 'filtered', config }))?.candidateProbeCount, 120)
    const reserved = await reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      service: 'model-a',
      runId: 'filtered-run',
      epoch: 'filtered',
      config,
    })
    assert.equal(reserved.reference.probes.some((probe) => probe.domain === 'medical'), false)

    // Another model's excluded domains don't count; a set made without the exclusion is not loaded with it.
    await makeSet(directory, 'unfiltered', { config: excludedDomainConfig('different-model') })
    assert.equal((await loadEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: 'unfiltered' }))?.candidateProbeCount, 200)
    const unfiltered = await reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '22'.repeat(20),
      service: 'model-a',
      runId: 'unfiltered-run',
      epoch: 'unfiltered',
    })
    await assert.rejects(loadModelAuditReservation({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '22'.repeat(20),
      auditId: unfiltered.auditId,
      config,
    }), /contains an excluded domain/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('repeated canonical probes merge refreshed contrast and self-test evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-repeated-'))
  try {
    const first = await appendReference(directory)
    const existing = JSON.parse(await readFile(first.path, 'utf8')) as {
      probes: Array<{
        probe: KbfReferenceV1['probes'][number]
        selfTest: { answers: Array<number | null>; matches: Array<0 | 1 | null> }
      }>
    }
    existing.probes[0]!.probe.contrast = { distinguishingModels: ['older-contrast'] }
    existing.probes[0]!.selfTest = { answers: [null], matches: [0] }
    await writeFile(first.path, JSON.stringify(existing), 'utf8')

    const repeated = await appendReference(directory)
    assert.equal(repeated.addedProbeCount, 0)
    assert.equal(repeated.totalProbeCount, 200)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('probe banks reject incompatible query profiles', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    await appendReference(directory)
    const incompatible = reference()
    incompatible.queryProfile = createReferenceQueryProfile({ upstreamModel: 'different-upstream' })
    incompatible.referenceId = computeReferenceId(incompatible)
    await assert.rejects(
      appendReference(directory, incompatible),
      /incompatible/,
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bank selections grow until every contrast model would be flagged DIFF', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-contrast-'))
  try {
    const value = reference()
    // contrast-b only misses every fifth probe after the first hundred.
    value.contrasts.push({
      model: 'contrast-b',
      distinguishingProbeIds: value.probes.filter((_probe, index) => index >= 100 && index % 5 === 0)
        .map((probe) => probe.id),
    })
    value.referenceId = computeReferenceId(value)
    await appendReference(directory, value)
    await makeSet(directory, '4')
    const reserved = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4',
    })
    assert.ok(reserved.reference.probes.length > 100)
    const detection = reserved.reference.contrastDetection!
    assert.deepEqual(detection.map((entry) => entry.model), ['contrast-a', 'contrast-b'])
    assert.equal(detection.every((entry) => entry.detected), true)
    assert.equal(detection[1]!.total, reserved.reference.probes.length)

    // Capped at 100 questions, a set can't detect contrast-b.
    await appendReference(directory, value, '5')
    assert.equal((await selectAll(directory, '5', { config: { referenceMaximumProbeCount: 100 } })).status, 'short')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bank readiness counts a contrast only on probes it answered', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-answered-'))
  try {
    const value = reference(100)
    // contrast-b answered only the first 10 probes and missed 5 of them.
    const answeredByB = new Set(value.probes.slice(0, 10).map((probe) => probe.id))
    value.contrasts.push({
      model: 'contrast-b',
      distinguishingProbeIds: value.probes.slice(0, 5).map((probe) => probe.id),
    })
    value.referenceId = computeReferenceId(value)
    const withoutAnswered = join(directory, 'without')
    await appendReference(withoutAnswered, value)
    const unknown = await selectAll(withoutAnswered, '4', { config: { referenceMaximumProbeCount: 100 } })
    assert.equal(unknown.status, 'short')

    const withAnswered = join(directory, 'with')
    await appendModelReferenceToBank({
      banksDir: withAnswered,
      model: 'model-a',
      epoch: '4',
      reference: value,
      cost: referenceCost,
      answeredContrastModelsByProbeId: new Map(value.probes.map((probe) => [
        probe.id,
        answeredByB.has(probe.id) ? ['contrast-a', 'contrast-b'] : ['contrast-a'],
      ])),
    })
    const bank = JSON.parse(await readFile(epochBankPath(withAnswered, 'model-a', '4'), 'utf8')) as {
      probes: Array<{ probe: { id: string }; answeredContrastModels?: string[] }>
    }
    assert.deepEqual(bank.probes[0]!.answeredContrastModels, ['contrast-a', 'contrast-b'])
    assert.deepEqual(bank.probes[50]!.answeredContrastModels, ['contrast-a'])
    const known = await selectAll(withAnswered, '4', { config: { referenceMaximumProbeCount: 100 } })
    assert.equal(known.status === 'ready' && known.set.reference.probes.length, 100)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('probe banks reject incompatible enrollment algorithms', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-enrollment-'))
  try {
    await appendReference(directory)
    const incompatible = reference()
    incompatible.generator = {
      ...incompatible.generator,
      version: 'next',
      params: {
        ...incompatible.generator.params,
        enrollmentBatchingVersion: 2,
        enrollmentStabilityVersion: 2,
      },
    }
    incompatible.referenceId = computeReferenceId(incompatible)
    await assert.rejects(appendReference(directory, incompatible), /incompatible with the new reference/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a changed alias list never makes a bank incompatible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-aliases-'))
  try {
    await appendReference(directory, reference(), 'alias')
    // A later build for the same model, after sellers' extra names were added.
    const renamed = reference()
    renamed.serviceAliases = ['model-a', 'model-a-1', 'vendor/model-a']
    renamed.referenceId = computeReferenceId(renamed)
    const appended = await appendReference(directory, renamed, 'alias')
    assert.equal(appended.totalProbeCount, 200)
    // Audits draw from the bank as before.
    await makeSet(directory, 'alias', { config: { referenceMaximumProbeCount: 100 } })
    const reserved = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '22'.repeat(20), service: 'model-a',
      runId: 'alias-run', epoch: 'alias', config: { referenceMaximumProbeCount: 100 },
    })
    assert.equal(reserved.reference.probes.length > 0, true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('question sets reject banks of an earlier reference builder', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-legacy-enrollment-'))
  try {
    const legacy = reference()
    legacy.generator = {
      name: 'antseed-simple-reference-builder',
      version: '2',
      verifierKind: 'kbf',
      params: {},
    }
    legacy.referenceId = computeReferenceId(legacy)
    const appended = await appendReference(directory, legacy, '7')
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '7', probeIds: appended.addedProbeIds })
    await assert.rejects(selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '7', runId: 'run-a', extensionCount: 0,
    }), /archive it and rebuild with enrollment \d+/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('bank-selected references pool every self-test run and size power for the audit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-pooled-'))
  try {
    const pooled = reference()
    pooled.selfTest.outcomes = pooled.probes.map((probe, index) => ({
      probeId: probe.id,
      answers: [probe.consensus, index === 0 ? null : probe.consensus, probe.consensus],
      matches: [1, index === 0 ? 0 : 1, 1],
    }))
    pooled.selfTest = { ...pooled.selfTest, hamming: 1, total: 600, coverage: 599 / 600, errorRate: 1 / 600 }
    const power = computeBinomialPower({
      selfHamming: 1, selfTotal: 600, probeCount: 200, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
    })
    pooled.statisticalPower = power.power
    pooled.statisticalPowerEvidence = {
      ...pooled.statisticalPowerEvidence,
      selfHamming: 1, selfTotal: 600, probeCount: 200, p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount, power: power.power,
    }
    pooled.referenceId = computeReferenceId(pooled)
    await appendReference(directory, pooled, '9')
    await makeSet(directory, '9')
    const reserved = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '9',
    })
    const count = reserved.reference.probes.length
    // The bank stored the missing run as 0 (older rule); it is re-scored as unscored on load.
    assert.equal(reserved.reference.selfTest.total, count * 3 - 1)
    assert.equal(reserved.reference.selfTest.hamming, 0)
    assert.equal(reserved.reference.statisticalPowerEvidence.selfTotal, count * 3 - 1)
    assert.equal(reserved.reference.statisticalPowerEvidence.probeCount, count)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/**
 * `reference(count)` with ids `<prefix>-<n>`; the first `keepText` probes keep the text of
 * `reference()`'s probes (the same questions under new ids), the rest get new text.
 */
function renamedReference(count: number, prefix: string, keepText: number): KbfReferenceV1 {
  const value = reference(count)
  const ids = new Map(value.probes.map((probe, index) => [probe.id, `${prefix}-${index + 1}`]))
  value.probes = value.probes.map((probe, index) => ({
    ...probe,
    id: ids.get(probe.id)!,
    ...(index < keepText ? {} : { name: `${prefix} question ${index + 1}`, template: `The ${prefix} value ${index + 1} is ___.` }),
  }))
  value.selfTest.outcomes = value.selfTest.outcomes.map((outcome) => ({ ...outcome, probeId: ids.get(outcome.probeId)! }))
  value.contrasts = [{ model: 'contrast-a', distinguishingProbeIds: value.probes.map((probe) => probe.id) }]
  value.referenceId = computeReferenceId(value)
  return value
}

const ids = (value: { probes: Array<{ id: string }> }) => value.probes.map((probe) => probe.id)

test('every seller of a model gets the same question set this epoch, and every close call the same extra sets', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-epoch-set-'))
  const sellers = ['11', '22', '33'].map((prefix) => prefix.repeat(20))
  try {
    await appendReference(directory, reference(300))
    const set = await makeSet(directory, '4', { extensionCount: 2 })
    assert.equal(set.method, EPOCH_QUESTION_SET_METHOD)
    assert.equal(set.reference.probes.length, 100)
    assert.deepEqual(set.extensions.map((extension) => extension.probes.length), [100, 100])
    const all = [...ids(set.reference), ...set.extensions.flatMap(ids)]
    assert.equal(new Set(all).size, 300, 'the audit set and the extra sets share no question')

    const firsts = await Promise.all(sellers.map((seller) => reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '4',
    })))
    assert.equal(new Set(firsts.map((first) => first.ledgerPath)).size, 3)
    for (const first of firsts) {
      assert.equal(first.reference.referenceId, set.reference.referenceId)
      assert.deepEqual(ids(first.reference), ids(set.reference), 'same questions in the same order')
    }
    for (const extensionIndex of [1, 2]) {
      const extras = await Promise.all(sellers.map((seller) => reserveExtensionReference({
        banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '4',
        firstReferenceId: set.reference.referenceId, probeCount: 100, extensionIndex,
      })))
      for (const extra of extras) assert.equal(extra.reference.referenceId, set.extensions[extensionIndex - 1]!.referenceId)
      // A resumed run gets the same reservation back.
      const again = await reserveExtensionReference({
        banksDir: directory, model: 'model-a', sellerPeerId: sellers[0]!, service: 'model-a', runId: 'run-b', epoch: '4',
        firstReferenceId: set.reference.referenceId, probeCount: 100, extensionIndex,
      })
      assert.equal(again.auditId, extras[0]!.auditId)
      const loaded = await loadModelAuditReservation({ banksDir: directory, model: 'model-a', sellerPeerId: sellers[1]!, auditId: extras[1]!.auditId })
      assert.equal(loaded.reference.referenceId, set.extensions[extensionIndex - 1]!.referenceId)
    }
    const loaded = await loadModelAuditReservation({ banksDir: directory, model: 'model-a', sellerPeerId: sellers[2]!, auditId: firsts[2]!.auditId })
    assert.equal(loaded.reference.referenceId, set.reference.referenceId)
    const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', sellers[0]!), 'utf8'))
    assert.equal(ledger.assignments[0].selection, EPOCH_QUESTION_SET_METHOD)
    // Evidence finds every reference of the set.
    for (const value of [set.reference, ...set.extensions]) {
      assert.equal((await findEpochProbeReference(directory, value.referenceId) as KbfReferenceV1 | null)?.referenceId, value.referenceId)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('sellers wait for calibration: an uncalibrated or failed set reserves nothing, and a passed one stays put', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-uncalibrated-'))
  const reserve = () => reserveModelAuditReference({
    banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: '4',
  })
  try {
    const appended = await appendReference(directory, reference(200))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: appended.addedProbeIds })
    const selection = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '4', runId: 'set-run', extensionCount: 0, shuffle: identityShuffle,
    })
    assert.equal(selection.status, 'ready')
    if (selection.status !== 'ready') return
    await assert.rejects(reserve(), /NO_EPOCH_QUESTION_SET.*has not been calibrated/)
    assert.equal(selection.set.calibration, undefined)
    const set = await calibrate(directory, '4', selection.set)
    assert.equal(set.calibration?.status, 'passed')
    assert.equal(set.calibration?.passes, 1)
    assert.notEqual(set.reference.referenceId, selection.set.reference.referenceId)
    const reserved = await reserve()
    assert.equal(reserved.reference.referenceId, set.reference.referenceId)
    assert.equal(reserved.reference.calibration?.total, reserved.reference.probes.length)
    // Calibrated once: a second record changes nothing, and the published reference is found by its new id.
    const again = await calibrate(directory, '4', { ...set, reference: selection.set.reference })
    assert.equal(again.reference.referenceId, set.reference.referenceId)
    assert.equal((await findEpochProbeReference(directory, set.reference.referenceId) as KbfReferenceV1 | null)?.referenceId, set.reference.referenceId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('each epoch builds into its own bank: a new epoch\'s set comes from its own questions, also ones asked in an earlier epoch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-per-epoch-'))
  const select = (epoch: string) => selectEpochQuestionSet({
    banksDir: directory, model: 'model-a', epoch, runId: 'run-a', extensionCount: 0, shuffle: identityShuffle,
  })
  try {
    // Before any build of the epoch there is nothing to select from, and nothing is written.
    assert.deepEqual(await select('3'), { status: 'short', reason: 'no questions were built for epoch 3 yet', candidateProbeCount: 0 })
    const first = await appendReference(directory, reference(200), '3')
    assert.equal(first.path, join(directory, 'model-a', 'epochs', '3', 'bank.json'))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '3', probeIds: first.addedProbeIds })
    const earlier = await select('3')
    assert.equal(earlier.status, 'ready')
    // The next epoch's build wrote 50 of epoch 3's questions again, under new ids: they are its questions too.
    const next = await appendReference(directory, renamedReference(250, 'next', 50), '4')
    assert.equal(next.path, join(directory, 'model-a', 'epochs', '4', 'bank.json'))
    assert.equal(next.totalProbeCount, 250, 'epoch 3\'s questions are not in epoch 4\'s bank')
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: next.addedProbeIds })
    const selection = await select('4')
    assert.equal(selection.status, 'ready')
    if (selection.status !== 'ready' || earlier.status !== 'ready') return
    assert.equal(selection.set.candidateProbeCount, 250)
    assert.equal('previouslyAskedProbeCount' in selection.set, false)
    assert.equal(ids(selection.set.reference).every((id) => id.startsWith('next-')), true, 'only questions built for this epoch')
    assert.equal(selection.set.reference.probes.some((probe) => probe.template === 'The test value 1 is ___.'), true)
    // Each epoch's set is checked against its own bank.
    assert.equal((await loadEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: '3' }))?.reference.referenceId, earlier.set.reference.referenceId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('without this epoch\'s question set, nothing is reserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-no-set-'))
  const seller = '11'.repeat(20)
  try {
    await appendReference(directory, reference(200), '5')
    await assert.rejects(reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '5',
    }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
    // A set made without extra sets leaves a close call undecided.
    const set = await makeSet(directory, '5')
    await assert.rejects(reserveExtensionReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '5',
      firstReferenceId: set.reference.referenceId, probeCount: 100,
    }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('too few new questions leave the set short and write nothing; a set once made stays as it is', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-short-'))
  try {
    const appended = await appendReference(directory, reference(150), '6')
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '6', probeIds: appended.addedProbeIds })
    const select = (extensionCount: number, shuffle = identityShuffle) => selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '6', runId: 'run-a', extensionCount, shuffle,
    })
    const short = await select(2)
    assert.equal(short.status, 'short')
    await assert.rejects(readFile(epochQuestionSetPath(directory, 'model-a', '6')), /ENOENT/)
    // Another epoch's questions are not candidates.
    const other = await selectEpochQuestionSet({ banksDir: directory, model: 'model-a', epoch: '7', runId: 'run-a', extensionCount: 0 })
    assert.equal(other.status, 'short')
    const made = await select(0)
    assert.equal(made.status, 'ready')
    const again = await select(0, <T>(values: readonly T[]) => [...values].reverse())
    assert.equal(again.status === 'ready' && again.set.reference.referenceId, made.status === 'ready' && made.set.reference.referenceId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('voided seller reservations get the same set again, and voiding is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    await appendReference(directory)
    await makeSet(directory, '4')
    const first = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: '4',
    })
    const voided = await voidModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), auditId: first.auditId,
      reason: 'stale model advertisement', now: () => Date.parse('2026-08-10T00:00:00.000Z'),
    })
    const repeated = await voidModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), auditId: first.auditId,
      reason: 'ignored replacement reason', now: () => Date.parse('2026-08-11T00:00:00.000Z'),
    })
    assert.equal(repeated.voidedAt, voided.voidedAt)
    const second = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20), service: 'model-a', runId: 'run-a', epoch: '4',
    })
    assert.deepEqual(ids(second.reference), ids(first.reference))
    const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', '11'.repeat(20)), 'utf8'))
    assert.equal(ledger.assignments[0].voidReason, 'stale model advertisement')
    assert.equal(ledger.assignments[0].voidedAt, '2026-08-10T00:00:00.000Z')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** A submit's retire before an upload of `published` (by default nothing of the bank: the first upload decides alone). */
const retire = (
  banksDir: string,
  epoch: string,
  published: Parameters<typeof retireEpochQuestionSet>[0]['published'] = { referenceIds: [], exchanges: [] },
) => retireEpochQuestionSet({
  banksDir, model: 'model-a', epoch, runId: 'submit-run', published, now: () => Date.parse('2026-08-07T00:00:00.000Z'),
})
/** The epoch's set and pool files (its bank and the bank's evidence sit beside them). */
const epochFiles = async (banksDir: string, epoch: string) => (await readdir(join(banksDir, 'model-a', 'epochs', epoch)))
  .filter((name) => /^(?:set|pool)\b/.test(name)).sort()
const [sellerA, sellerB] = ['11'.repeat(20), '22'.repeat(20)]

/**
 * Epoch 4's set with seller A reserved on it, then a submit's retire. `rebuild`
 * banks a new build (50 of its 300 questions repeat old text under new ids) and makes and calibrates the next set.
 */
async function withRetiredSet(body: (input: {
  directory: string
  first: EpochQuestionSetV1
  reservedA: Awaited<ReturnType<typeof reserveModelAuditReference>>
  retired: { retired: boolean }
  reserve: (seller: string) => ReturnType<typeof reserveModelAuditReference>
  rebuild: () => Promise<EpochQuestionSetV1>
}) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-retired-'))
  const reserve = (seller: string) => reserveModelAuditReference({
    banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '4',
  })
  const rebuild = async () => {
    const rebuilt = await appendReference(directory, renamedReference(300, 'next', 50))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: rebuilt.addedProbeIds })
    const selection = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '4', runId: 'run-b', extensionCount: 1, shuffle: identityShuffle,
    })
    if (selection.status !== 'ready') throw new Error(`no set: ${selection.reason}`)
    return selection.set.calibration ? selection.set : calibrate(directory, '4', selection.set)
  }
  try {
    await appendReference(directory, reference(300))
    const first = await makeSet(directory, '4', { extensionCount: 1 })
    const reservedA = await reserve(sellerA)
    const retired = await retire(directory, '4')
    await body({ directory, first, reservedA, retired, reserve, rebuild })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('a published question set is retired: no seller is reserved on it, and retiring again does nothing', () => withRetiredSet(async ({ directory, reserve, retired }) => {
  await assert.rejects(reserve(sellerB), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
  assert.deepEqual(retired, { retired: true })
  assert.deepEqual(await epochFiles(directory, '4'), ['pool.published-1.json', 'set.published-1.json'])
  const stored = JSON.parse(await readFile(join(directory, 'model-a', 'epochs', '4', 'set.published-1.json'), 'utf8')) as EpochQuestionSetV1
  assert.deepEqual(stored.retired, {
    at: '2026-08-07T00:00:00.000Z', runId: 'submit-run',
    bankExchanges: (await bankExchanges(directory)).map(({ referenceId, sha256 }) => `${referenceId} ${sha256}`),
  })
  assert.deepEqual(await retire(directory, '4'), { retired: false })
  assert.deepEqual(await epochFiles(directory, '4'), ['pool.published-1.json', 'set.published-1.json'])
}))

test('the set built after a retire shares no question with the retired set or pool', () => withRetiredSet(async ({ directory, first, reserve, rebuild }) => {
  const second = await rebuild()
  const reservedB = await reserve(sellerB)
  assert.equal(reservedB.reference.referenceId, second.reference.referenceId)
  const retiredPool = JSON.parse(await readFile(join(directory, 'model-a', 'epochs', '4', 'pool.published-1.json'), 'utf8')) as { probeIds: string[] }
  const publicIds = new Set([...ids(first.reference), ...first.extensions.flatMap(ids), ...retiredPool.probeIds])
  for (const probe of [...second.reference.probes, ...second.extensions.flatMap((entry) => entry.probes)]) {
    assert.equal(publicIds.has(probe.id), false, `${probe.id} was published`)
  }
}))

test('an audit made on a retired set still loads the same reference, calibration included', () => withRetiredSet(async ({ directory, first, reservedA }) => {
  const loaded = await loadModelAuditReservation({ banksDir: directory, model: 'model-a', sellerPeerId: sellerA, auditId: reservedA.auditId })
  assert.equal(loaded.reference.referenceId, first.reference.referenceId)
  assert.deepEqual(loaded.reference.calibration, first.reference.calibration)
  assert.equal(loaded.retired, true)
  assert.equal((await findEpochProbeReference(directory, first.extensions[0]!.referenceId) as KbfReferenceV1 | null)?.referenceId, first.extensions[0]!.referenceId)
}))

test('a close call made on a retired set gets no extra questions, of that set or of the next, and nothing is written', () => withRetiredSet(async ({ directory, reservedA, reserve, rebuild }) => {
  const extend = () => reserveExtensionReference({
    banksDir: directory, model: 'model-a', sellerPeerId: sellerA, service: 'model-a', runId: 'run-a', epoch: '4',
    firstReferenceId: reservedA.reference.referenceId, probeCount: 100,
  })
  const ledgerBefore = await readFile(sellerLedgerPath(directory, 'model-a', sellerA), 'utf8')
  const published = new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}: .*was published, so its extra questions are public`)
  await assert.rejects(extend(), published)
  const second = await rebuild()
  await assert.rejects(extend(), published)
  assert.equal(await readFile(sellerLedgerPath(directory, 'model-a', sellerA), 'utf8'), ledgerBefore)
  // A close call on the new set gets the new set's extra questions.
  const reservedB = await reserve(sellerB)
  const extra = await reserveExtensionReference({
    banksDir: directory, model: 'model-a', sellerPeerId: sellerB, service: 'model-a', runId: 'run-b', epoch: '4',
    firstReferenceId: reservedB.reference.referenceId, probeCount: 100,
  })
  assert.equal(extra.reference.referenceId, second.extensions[0]!.referenceId)
}))

test('a retry of an audit made on a retired set is not resumed: it is reserved on the new set and asks none of the old questions', () => withRetiredSet(async ({ directory, first, reservedA, reserve, rebuild }) => {
  const { filterCompatibleResumeCandidates } = await import('../cli/commands/verifier/run.js')
  const second = await rebuild()
  // The seller's earlier, partial audit on the retired set, as a retry finds it.
  const candidate = {
    model: 'model-a', peerId: sellerA, service: 'model-a', auditId: reservedA.auditId, reservationAuditId: reservedA.auditId,
    evidencePath: join(directory, 'evidence.json'), evidenceHash: `0x${'44'.repeat(32)}`,
    referenceId: reservedA.reference.referenceId, queryProfileHash: queryProfileHash(reservedA.reference.queryProfile),
    probeIds: ids(reservedA.reference), exchanges: [],
  }
  const candidates = new Map([['model-a:a', candidate]])
  // `--resume-run` says what to do instead.
  await assert.rejects(
    filterCompatibleResumeCandidates({ candidates, banksDir: directory, epoch: '4', strict: true }),
    /was asked on a question set a submit has published since, so it can't be resumed; run without --resume-run/,
  )
  // An automatic retry drops it, and its old reservation is voided so the ledger shows it as not active.
  assert.equal((await filterCompatibleResumeCandidates({ candidates, banksDir: directory, epoch: '4', strict: false })).size, 0)
  const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', sellerA), 'utf8')) as {
    assignments: Array<{ auditId: string; voidedAt?: string; voidReason?: string }>
  }
  const old = ledger.assignments.find((entry) => entry.auditId === reservedA.auditId)
  assert.ok(old?.voidedAt)
  assert.match(old.voidReason!, /question set was published by a submit/)
  // `--resume-run` after that void still says what to do.
  await assert.rejects(
    filterCompatibleResumeCandidates({ candidates, banksDir: directory, epoch: '4', strict: true }),
    /was asked on a question set a submit has published since, so it can't be resumed; run without --resume-run/,
  )
  // Without a resume, the run reserves the seller as for a first audit.
  const retry = await reserve(sellerA)
  assert.equal(retry.reference.referenceId, second.reference.referenceId)
  const oldIds = new Set([...ids(first.reference), ...first.extensions.flatMap(ids)])
  assert.equal(ids(retry.reference).some((id) => oldIds.has(id)), false)
}))

test('retiring a pool without a set: its published questions are never selected later', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-retired-pool-'))
  try {
    const appended = await appendReference(directory, reference(300))
    // A build for the epoch whose questions were too few for a set when a submit published the bank.
    const shortPool = appended.addedProbeIds.slice(0, 50)
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: shortPool })
    const short = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '4', runId: 'run-a', extensionCount: 0, shuffle: identityShuffle,
    })
    assert.equal(short.status, 'short')
    const retired = await retire(directory, '4')
    // The next build adds new questions; the pool's earlier questions stay out.
    const rebuilt = await appendReference(directory, renamedReference(300, 'next', 0))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: rebuilt.addedProbeIds })
    const selection = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '4', runId: 'run-b', extensionCount: 0, shuffle: identityShuffle,
    })
    assert.equal(selection.status, 'ready')
    if (selection.status !== 'ready') return
    const published = new Set(shortPool)
    assert.equal(ids(selection.set.reference).some((id) => published.has(id)), false, 'a published pool question was selected')
    assert.deepEqual(retired, { retired: true })
    assert.deepEqual(await epochFiles(directory, '4'), ['pool.json', 'pool.published-1.json', 'set.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

/** The bank's exchange files as an upload's evidence lists them. */
const bankExchanges = async (banksDir: string, epoch = '4') => (await loadBankReferenceExchanges(banksDir, 'model-a', epoch))
  .map(({ referenceId, sha256 }) => ({ referenceId, sha256 }))

test('an upload that carries nothing banked since the last retire retires nothing; one that does retires the new set', () => withRetiredSet(async ({ directory, first, rebuild }) => {
  // Tick 1's upload carried the bank as it was then, and failed after its retire.
  const tickOne = { referenceIds: [first.reference.referenceId], exchanges: await bankExchanges(directory) }
  const second = await rebuild()
  // Tick 2 sends tick 1's stored evidence again: nothing of the new set is in it.
  assert.deepEqual(await retire(directory, '4', tickOne), { retired: false })
  assert.deepEqual(await epochFiles(directory, '4'), ['pool.json', 'pool.published-1.json', 'set.json', 'set.published-1.json'])
  // Evidence prepared now lists the new set's calibration exchanges, or names the new set: retired.
  assert.deepEqual(await retire(directory, '4', { referenceIds: [first.reference.referenceId], exchanges: await bankExchanges(directory) }), { retired: true })
  assert.ok((await epochFiles(directory, '4')).includes('set.published-2.json'))
  const third = await rebuildAgain(directory, 'third')
  assert.deepEqual(await retire(directory, '4', { referenceIds: [third.reference.referenceId], exchanges: tickOne.exchanges }), { retired: true })
  assert.notEqual(second.reference.referenceId, third.reference.referenceId)
}))

test('an earlier retire whose record can\'t be read never stops a retire', () => withRetiredSet(async ({ directory, first, rebuild }) => {
  const tickOne = { referenceIds: [first.reference.referenceId], exchanges: await bankExchanges(directory) }
  await rebuild()
  const recordPath = join(directory, 'model-a', 'epochs', '4', 'set.published-1.json')
  const record = JSON.parse(await readFile(recordPath, 'utf8')) as { retired: { bankExchanges?: string[] } }
  delete record.retired.bankExchanges
  await writeFile(recordPath, JSON.stringify(record))
  assert.deepEqual(await retire(directory, '4', tickOne), { retired: true })
}))

/** Another build and set after `rebuild` (new ids and text), calibrated. */
async function rebuildAgain(directory: string, prefix: string): Promise<EpochQuestionSetV1> {
  const rebuilt = await appendReference(directory, renamedReference(300, prefix, 0))
  await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: rebuilt.addedProbeIds })
  const selection = await selectEpochQuestionSet({
    banksDir: directory, model: 'model-a', epoch: '4', runId: 'run-c', extensionCount: 1, shuffle: identityShuffle,
  })
  if (selection.status !== 'ready') throw new Error(`no set: ${selection.reason}`)
  return calibrate(directory, '4', selection.set)
}

test('a reference is known to be in a retired set from the retired file alone, also when that set no longer validates', () => withRetiredSet(async ({ directory, first }) => {
  const lookup = (referenceId: string) => isRetiredEpochQuestionSetReference({ banksDir: directory, model: 'model-a', epoch: '4', referenceId })
  assert.equal(await lookup(first.reference.referenceId), true)
  assert.equal(await lookup(first.extensions[0]!.referenceId), true)
  assert.equal(await lookup('sha256:not-in-any-set'), false)
  // A bank rebuild changes its compatibility hash: the retired set no longer validates, but its questions are public.
  const path = epochBankPath(directory, 'model-a', '4')
  const bank = JSON.parse(await readFile(path, 'utf8')) as { compatibilityHash: string }
  await writeFile(path, JSON.stringify({ ...bank, compatibilityHash: `0x${'ee'.repeat(32)}` }))
  await assert.rejects(findEpochQuestionSetByReferenceId({ banksDir: directory, model: 'model-a', epoch: '4', referenceId: first.reference.referenceId }))
  assert.equal(await lookup(first.reference.referenceId), true)
}))

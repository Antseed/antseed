import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  KBF_CALIBRATION_METHOD,
  aggregateKbfSelfTestOutcomes,
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceCalibrationV1,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import { setAuditedModelsForTesting } from './audited-models.js'
import { kbfAuditBatches } from './kbf-batching.js'
import {
  appendModelReferenceToBank,
  bankPath,
  EPOCH_QUESTION_SET_METHOD,
  epochProbeReferencePath,
  epochQuestionSetPath,
  findEpochProbeReference,
  inspectModelProbeBankPower,
  loadBankEnrollmentReference,
  loadModelAuditReservation,
  missingBankReferenceExchanges,
  NO_EPOCH_QUESTION_SET,
  questionTextKey,
  recordEpochQuestionPool,
  recordEpochSetCalibration,
  reserveExtensionReference,
  reserveModelAuditReference,
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

function appendReference(banksDir: string, value = reference()) {
  return appendModelReferenceToBank({ banksDir, model: 'model-a', reference: value, cost: referenceCost })
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

/** Makes `epoch`'s question set from every question banked so far, in bank order, and calibrates it. */
async function makeSet(
  banksDir: string,
  epoch: string,
  options: { config?: VerifierCLIConfig; extensionCount?: number } = {},
): Promise<EpochQuestionSetV1> {
  const bank = JSON.parse(await readFile(bankPath(banksDir, 'model-a'), 'utf8')) as { probes: Array<{ probe: { id: string } }> }
  await recordEpochQuestionPool({ banksDir, model: 'model-a', epoch, probeIds: bank.probes.map((entry) => entry.probe.id) })
  const selection = await selectEpochQuestionSet({
    banksDir, model: 'model-a', epoch, runId: 'set-run', extensionCount: options.extensionCount ?? 0,
    config: options.config, shuffle: identityShuffle,
  })
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
    assert.equal((await loadBankEnrollmentReference(oddDir, 'model-a'))?.probes.length, 170)

    // 760 probes are more than one reference may hold.
    const largeDir = join(directory, 'large')
    await appendReference(largeDir, reference(380))
    await appendReference(largeDir, shiftedReference(380, 380))
    const seed = await loadBankEnrollmentReference(largeDir, 'model-a')
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
    const appended = await appendReference(directory)
    const bank = JSON.parse(await readFile(appended.path, 'utf8')) as { referenceExchanges?: Array<Record<string, unknown>> }
    const entry = { sha256: 'sha256:00', upstream: null, exchangeCount: 1, requestCount: 1 }
    bank.referenceExchanges = [
      { ...entry, referenceId: 'sha256:aa', path: 'reference-evidence/sha256:aa.exchanges.json' },
      { ...entry, referenceId: 'sha256:bb', path: 'reference-evidence/sha256:bb.exchanges.json' },
    ]
    await writeFile(appended.path, JSON.stringify(bank))
    await mkdir(join(dirname(appended.path), 'reference-evidence'), { recursive: true })
    await writeFile(join(dirname(appended.path), 'reference-evidence', 'sha256:aa.exchanges.json'), '{}')
    assert.deepEqual(await missingBankReferenceExchanges(directory, 'model-a'), ['reference-evidence/sha256:bb.exchanges.json'])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('probe bank power inspection recognizes a reusable powered reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-power-'))
  try {
    const missing = await inspectModelProbeBankPower({ banksDir: directory, model: 'model-a' })
    assert.deepEqual(missing, {
      totalProbeCount: 0,
      eligibleProbeCount: 0,
      selectedProbeCount: null,
      statisticalPower: null,
    })

    const appended = await appendReference(directory)
    const powered = await inspectModelProbeBankPower({ banksDir: directory, model: 'model-a' })
    assert.equal(powered.totalProbeCount, 200)
    assert.equal(powered.eligibleProbeCount, 200)
    assert.equal(powered.selectedProbeCount, 100)
    assert.ok((powered.statisticalPower ?? 0) >= 0.9)

    const legacy = JSON.parse(await readFile(appended.path, 'utf8')) as Record<string, unknown>
    delete legacy.referenceCosts
    await writeFile(appended.path, JSON.stringify(legacy), 'utf8')
    const withoutCosts = await inspectModelProbeBankPower({ banksDir: directory, model: 'model-a' })
    assert.equal(withoutCosts.selectedProbeCount, null)
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
    const noisy = await inspectModelProbeBankPower({ banksDir: directory, model: 'model-a' })
    assert.ok(noisy.selectedProbeCount !== null)
    assert.ok((noisy.statisticalPower ?? 0) >= 0.9)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
  const broken = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-broken-'))
  try {
    // 60% self-test disagreement: treated as a broken reference.
    await appendReference(broken, noisyReference(500, 3))
    const status = await inspectModelProbeBankPower({ banksDir: broken, model: 'model-a' })
    assert.equal(status.selectedProbeCount, null)
  } finally {
    await rm(broken, { recursive: true, force: true })
  }
})

test('excluded domains are ignored by bank power and audit reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-domains-'))
  try {
    const mixed = reference()
    for (const [index, probe] of mixed.probes.entries()) probe.domain = index < 80 ? 'medical' : 'biology'
    mixed.referenceId = computeReferenceId(mixed)
    await appendReference(directory, mixed)

    const unrelated = await inspectModelProbeBankPower({
      banksDir: directory,
      model: 'model-a',
      config: excludedDomainConfig('different-model'),
    })
    assert.equal(unrelated.eligibleProbeCount, 200)

    const config = excludedDomainConfig()
    const filtered = await inspectModelProbeBankPower({ banksDir: directory, model: 'model-a', config })
    assert.equal(filtered.totalProbeCount, 200)
    assert.equal(filtered.eligibleProbeCount, 120)
    assert.equal(filtered.selectedProbeCount, 100)

    await makeSet(directory, 'filtered', { config })
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

    await makeSet(directory, 'legacy')
    const legacy = await reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '22'.repeat(20),
      service: 'model-a',
      runId: 'legacy-run',
      epoch: 'legacy',
    })
    await assert.rejects(loadModelAuditReservation({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '22'.repeat(20),
      auditId: legacy.auditId,
      config,
    }), /contains an excluded domain/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('appending a rebuilt reference migrates legacy banks without cost metadata', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-legacy-cost-'))
  try {
    const first = await appendReference(directory)
    const legacy = JSON.parse(await readFile(first.path, 'utf8')) as Record<string, unknown>
    delete legacy.referenceCosts
    await writeFile(first.path, JSON.stringify(legacy), 'utf8')

    const migrated = await appendReference(directory)
    const bank = JSON.parse(await readFile(migrated.path, 'utf8')) as { referenceCosts: unknown[] }
    assert.equal(migrated.addedProbeCount, 0)
    assert.equal(bank.referenceCosts.length, 1)
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

test('references with split reference-endpoint settings join legacy banks with the same settings', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-endpoint-'))
  const settings = {
    reasoningStrategy: 'bare' as const,
    requestOverrides: {},
    requestOmissions: ['temperature' as const, 'top_p' as const],
  }
  try {
    const legacy = reference()
    Object.assign(legacy.queryProfile, settings)
    legacy.referenceId = computeReferenceId(legacy)
    await appendReference(directory, legacy)

    const split = reference()
    split.probes[0]!.id = 'probe-new'
    split.selfTest.outcomes[0]!.probeId = 'probe-new'
    split.contrasts[0]!.distinguishingProbeIds[0] = 'probe-new'
    split.generator = { ...split.generator, params: { referenceEndpointRequest: settings } }
    split.referenceId = computeReferenceId(split)
    const appended = await appendReference(directory, split)
    assert.equal(appended.addedProbeCount, 1)

    const different = reference()
    different.generator = {
      ...different.generator,
      params: { referenceEndpointRequest: { ...settings, requestOmissions: [] } },
    }
    different.referenceId = computeReferenceId(different)
    await assert.rejects(appendReference(directory, different), /incompatible/)
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

    const smaller = await inspectModelProbeBankPower({
      banksDir: directory,
      model: 'model-a',
      config: { referenceMaximumProbeCount: 100 },
    })
    assert.equal(smaller.selectedProbeCount, null)
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
    const unknown = await inspectModelProbeBankPower({
      banksDir: withoutAnswered, model: 'model-a', config: { referenceMaximumProbeCount: 100 },
    })
    assert.equal(unknown.selectedProbeCount, null)

    const withAnswered = join(directory, 'with')
    await appendModelReferenceToBank({
      banksDir: withAnswered,
      model: 'model-a',
      reference: value,
      cost: referenceCost,
      answeredContrastModelsByProbeId: new Map(value.probes.map((probe) => [
        probe.id,
        answeredByB.has(probe.id) ? ['contrast-a', 'contrast-b'] : ['contrast-a'],
      ])),
    })
    const bank = JSON.parse(await readFile(join(withAnswered, 'model-a', 'bank.json'), 'utf8')) as {
      probes: Array<{ probe: { id: string }; answeredContrastModels?: string[] }>
    }
    assert.deepEqual(bank.probes[0]!.answeredContrastModels, ['contrast-a', 'contrast-b'])
    assert.deepEqual(bank.probes[50]!.answeredContrastModels, ['contrast-a'])
    const known = await inspectModelProbeBankPower({
      banksDir: withAnswered, model: 'model-a', config: { referenceMaximumProbeCount: 100 },
    })
    assert.equal(known.selectedProbeCount, 100)
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
    await appendReference(directory)
    // A later build for the same model, after sellers' extra names were added.
    const renamed = reference()
    renamed.serviceAliases = ['model-a', 'model-a-1', 'vendor/model-a']
    renamed.referenceId = computeReferenceId(renamed)
    const appended = await appendReference(directory, renamed)
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

test('question sets reject legacy Antseed enrollment banks', async () => {
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
    await appendReference(directory, legacy)
    await assert.rejects(inspectModelProbeBankPower({
      banksDir: directory,
      model: 'model-a',
    }), /archive it and rebuild with enrollment \d+/)
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
    await appendReference(directory, pooled)
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
        probeCount: 100, extensionIndex,
      })))
      for (const extra of extras) assert.equal(extra.reference.referenceId, set.extensions[extensionIndex - 1]!.referenceId)
      // A resumed run gets the same reservation back.
      const again = await reserveExtensionReference({
        banksDir: directory, model: 'model-a', sellerPeerId: sellers[0]!, service: 'model-a', runId: 'run-b', epoch: '4',
        probeCount: 100, extensionIndex,
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

test('a new question set never asks a question asked before, even under a new id', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-asked-before-'))
  try {
    await appendReference(directory, reference(200))
    const earlier = await makeSet(directory, '3')
    // The next epoch's build wrote 50 of the old questions again, under new ids.
    const rebuilt = await appendReference(directory, renamedReference(250, 'next', 50))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '4', probeIds: rebuilt.addedProbeIds })
    const selection = await selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '4', runId: 'run-b', extensionCount: 0, shuffle: identityShuffle,
    })
    assert.equal(selection.status, 'ready')
    if (selection.status !== 'ready') return
    const next = selection.set
    assert.equal(next.previouslyAskedProbeCount, 50)
    assert.equal(next.candidateProbeCount, 200)
    const oldText = new Set(reference(200).probes.map(questionTextKey))
    assert.equal(next.reference.probes.some((probe) => oldText.has(questionTextKey(probe))), false)
    assert.equal(ids(next.reference).some((id) => ids(earlier.reference).includes(id)), false, 'no question of an earlier epoch')
    assert.equal(ids(next.reference).every((id) => id.startsWith('next-')), true, 'only questions built for this epoch')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('without this epoch\'s question set, nothing is reserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-no-set-'))
  const seller = '11'.repeat(20)
  try {
    await appendReference(directory, reference(200))
    await assert.rejects(reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '5',
    }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
    // A set made without extra sets leaves a close call undecided.
    await makeSet(directory, '5')
    await assert.rejects(reserveExtensionReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'run-a', epoch: '5', probeCount: 100,
    }), new RegExp(`^Error: ${NO_EPOCH_QUESTION_SET}`))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('too few new questions leave the set short and write nothing; a set once made stays as it is', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-short-'))
  try {
    const appended = await appendReference(directory, reference(150))
    await recordEpochQuestionPool({ banksDir: directory, model: 'model-a', epoch: '6', probeIds: appended.addedProbeIds })
    const select = (extensionCount: number, shuffle = identityShuffle) => selectEpochQuestionSet({
      banksDir: directory, model: 'model-a', epoch: '6', runId: 'run-a', extensionCount, shuffle,
    })
    const short = await select(2)
    assert.equal(short.status, 'short')
    await assert.rejects(readFile(epochQuestionSetPath(directory, 'model-a', '6')), /ENOENT/)
    // Questions banked but not built for this epoch are not candidates.
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

test('legacy shared epoch references still load their reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const seller = '11'.repeat(20)
  try {
    const appended = await appendReference(directory)
    const set = await makeSet(directory, '3')
    const reserved = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, service: 'model-a', runId: 'legacy-run', epoch: '3',
    })
    const bank = JSON.parse(await readFile(appended.path, 'utf8')) as { compatibilityHash: string }
    await rm(epochQuestionSetPath(directory, 'model-a', '3'))
    await mkdir(dirname(epochProbeReferencePath(directory, 'model-a', '3')), { recursive: true })
    await writeFile(epochProbeReferencePath(directory, 'model-a', '3'), JSON.stringify({
      version: 1,
      kind: 'antseed-kbf-epoch-probe-reference',
      model: 'model-a',
      epoch: '3',
      compatibilityHash: bank.compatibilityHash,
      reference: set.reference,
      createdAt: set.createdAt,
      createdByRunId: 'legacy-run',
    }))
    const loaded = await loadModelAuditReservation({
      banksDir: directory, model: 'model-a', sellerPeerId: seller, auditId: reserved.auditId,
    })
    assert.equal(loaded.reference.referenceId, reserved.reference.referenceId)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

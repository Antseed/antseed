import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  computeBinomialPower,
  computeReferenceId,
  createReferenceQueryProfile,
  type KbfReferenceV1,
} from '@antseed/fingerprints'
import type { VerifierCLIConfig } from '../config/types.js'
import {
  appendModelReferenceToBank,
  BANK_EXHAUSTED,
  epochProbeReferencePath,
  inspectModelProbeBankPower,
  loadModelAuditReservation,
  listClaimableReferenceCosts,
  markReferenceCostsClaimed,
  reserveReferenceCosts,
  reserveModelAuditReference,
  sellerLedgerPath,
  voidModelAuditReference,
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

function excludedDomainConfig(model = 'model-a'): VerifierCLIConfig {
  return {
    referenceEndpoint: {
      baseUrl: 'https://reference.test/v1',
      sourceId: 'test',
      trust: 'trusted',
      models: {
        [model]: {
          upstreamModel: 'upstream-a',
          contrastModels: ['contrast-a'],
          excludedDomains: ['medical'],
        },
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
    selfHamming: 0, selfTotal: count, minimumMismatchDelta: 0.1, alpha: 0.05, cpConfidence: 0.99,
  })
  const value: KbfReferenceV1 = {
    version: 1,
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
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: count,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial', alpha: 0.05, clopperPearsonConfidence: 0.99,
      selfHamming: 0, selfTotal: count, p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1, criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [{ model: 'contrast-a', distinguishingProbeIds: probes.map((probe) => probe.id) }],
  }
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

test('excluded domains are ignored by bank power and audit reservations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-domains-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
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

    const reserved = await reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      service: 'model-a',
      runId: 'filtered-run',
      epoch: 'filtered',
      config,
      shuffle: identityShuffle,
    })
    assert.equal(reserved.reference.probes.some((probe) => probe.domain === 'medical'), false)

    const legacy = await reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '22'.repeat(20),
      service: 'model-a',
      runId: 'legacy-run',
      epoch: 'legacy',
      shuffle: identityShuffle,
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
        selfTest: { answer: number | null; match: 0 | 1 | null }
      }>
    }
    existing.probes[0]!.probe.contrast = { distinguishingModels: ['older-contrast'] }
    existing.probes[0]!.selfTest = { answer: null, match: null }
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

test('audit reservations reject legacy AntSeed enrollment banks', async () => {
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
    }), /archive it and rebuild with enrollment 4/)
    await assert.rejects(reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      service: 'model-a',
      runId: 'run-a',
      epoch: '7',
      config: undefined,
      shuffle: <T>(values: readonly T[]) => [...values],
    }), /archive it and rebuild with enrollment 4/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('every seller and run in an epoch shares one powered probe reference', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
  const reverseShuffle = <T>(values: readonly T[]) => [...values].reverse()
  try {
    await appendReference(directory)
    const first = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4', shuffle: reverseShuffle,
    })
    const second = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4', shuffle: identityShuffle,
    })
    assert.equal(first.reference.probes.length, 100)
    const epochReference = JSON.parse(await readFile(epochProbeReferencePath(directory, 'model-a', '4'), 'utf8'))
    assert.equal(epochReference.reference.referenceId, first.reference.referenceId)
    const loaded = await loadModelAuditReservation({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      auditId: first.auditId,
    })
    assert.equal(loaded.reference.referenceId, first.reference.referenceId)
    assert.deepEqual(
      loaded.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )
    assert.equal(second.reference.probes.length, 100)
    assert.deepEqual(
      second.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )

    const otherSeller = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '22'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4', shuffle: reverseShuffle,
    })
    assert.deepEqual(
      otherSeller.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )
    const nextRun = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-b', epoch: '4',
      shuffle: identityShuffle,
    })
    assert.deepEqual(
      nextRun.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )
    const nextEpoch = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-c', epoch: '5', shuffle: identityShuffle,
    })
    assert.equal(
      nextEpoch.reference.probes.some((probe) => first.reference.probes.some((other) => other.id === probe.id)),
      false,
    )
    await assert.rejects(
      reserveModelAuditReference({
        banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
        service: 'model-a', runId: 'run-d', epoch: '6', shuffle: identityShuffle,
      }),
      new RegExp(BANK_EXHAUSTED),
    )
    const reusedEpoch = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-d', epoch: '6', allowProbeReuse: true,
      shuffle: identityShuffle,
    })
    assert.deepEqual(
      reusedEpoch.reference.probes.map((probe) => probe.id),
      nextEpoch.reference.probes.map((probe) => probe.id),
    )
    const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', '11'.repeat(20)), 'utf8'))
    assert.equal(ledger.usedProbeIds, undefined)
    assert.equal(ledger.assignments.length, 5)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('voided seller assignments are reusable and voiding is idempotent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
  try {
    await appendReference(directory)
    const first = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4', shuffle: identityShuffle,
    })
    const voided = await voidModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      auditId: first.auditId,
      reason: 'stale model advertisement',
      now: () => Date.parse('2026-08-10T00:00:00.000Z'),
    })
    const repeated = await voidModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      auditId: first.auditId,
      reason: 'ignored replacement reason',
      now: () => Date.parse('2026-08-11T00:00:00.000Z'),
    })
    assert.equal(repeated.voidedAt, voided.voidedAt)

    const second = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'run-a', epoch: '4', shuffle: identityShuffle,
    })
    assert.deepEqual(
      second.reference.probes.map((probe) => probe.id),
      first.reference.probes.map((probe) => probe.id),
    )
    const ledger = JSON.parse(await readFile(sellerLedgerPath(directory, 'model-a', '11'.repeat(20)), 'utf8'))
    assert.equal(ledger.assignments[0].voidReason, 'stale model advertisement')
    assert.equal(ledger.assignments[0].voidedAt, '2026-08-10T00:00:00.000Z')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('legacy seller reservations remain loadable without an epoch reference file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
  try {
    await appendReference(directory)
    const reserved = await reserveModelAuditReference({
      banksDir: directory, model: 'model-a', sellerPeerId: '11'.repeat(20),
      service: 'model-a', runId: 'legacy-run', epoch: '3', shuffle: identityShuffle,
    })
    await rm(epochProbeReferencePath(directory, 'model-a', '3'))
    const loaded = await loadModelAuditReservation({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: '11'.repeat(20),
      auditId: reserved.auditId,
    })
    assert.equal(loaded.reference.referenceId, reserved.reference.referenceId)
    assert.deepEqual(
      loaded.reference.probes.map((probe) => probe.id),
      reserved.reference.probes.map((probe) => probe.id),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('different seller ledgers reserve the same epoch reference concurrently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  const identityShuffle = <T>(values: readonly T[]) => [...values]
  try {
    await appendReference(directory)
    const reservations = await Promise.all(['11', '22', '33', '44'].map((prefix) => reserveModelAuditReference({
      banksDir: directory,
      model: 'model-a',
      sellerPeerId: prefix.repeat(20),
      service: 'model-a',
      runId: 'run-a',
      epoch: '4',
      shuffle: identityShuffle,
    })))
    assert.equal(reservations.length, 4)
    assert.equal(new Set(reservations.map((reservation) => reservation.ledgerPath)).size, 4)
    assert.equal(new Set(reservations.map((reservation) => reservation.reference.referenceId)).size, 1)
    assert.deepEqual(
      reservations.map((reservation) => reservation.reference.probes.map((probe) => probe.id)),
      Array.from({ length: 4 }, () => reservations[0]!.reference.probes.map((probe) => probe.id)),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('reference costs reserve and claim exactly once for an evidence hash', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-probe-bank-'))
  try {
    await appendReference(directory)
    const claimable = await listClaimableReferenceCosts(directory, 'model-a')
    assert.equal(claimable.length, 1)
    const evidenceHash = `0x${'77'.repeat(32)}`
    const reserved = await reserveReferenceCosts({
      banksDir: directory,
      model: 'model-a',
      evidenceHash,
      costIds: claimable.map((entry) => entry.costId),
    })
    assert.equal(reserved[0]!.status, 'reserved')
    assert.equal((await listClaimableReferenceCosts(directory, 'model-a')).length, 0)
    assert.equal((await listClaimableReferenceCosts(directory, 'model-a', evidenceHash)).length, 1)
    await markReferenceCostsClaimed({
      banksDir: directory,
      model: 'model-a',
      evidenceHash,
      transactionHash: `0x${'88'.repeat(32)}`,
    })
    assert.equal((await listClaimableReferenceCosts(directory, 'model-a', evidenceHash)).length, 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

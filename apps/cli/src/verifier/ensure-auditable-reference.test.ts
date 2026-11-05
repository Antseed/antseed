import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { setAuditedModelsForTesting } from './audited-models.js'
import { BUILD_REQUEST_RUNS, EPOCH_SET_BUILD_ROUNDS, buildRequestLimits, enrollFreshProbes, ensureEpochQuestionSet } from './ensure-auditable-reference.js'
import type { EpochQuestionSetSelection, EpochQuestionSetV1 } from './probe-bank.js'

setAuditedModelsForTesting({ 'model-a': { upstreamModel: 'upstream-a', contrastModels: [] } })
import { referenceFixture } from './model-audit-fixtures.test-support.js'

type EnrollOperations = NonNullable<Parameters<typeof enrollFreshProbes>[1]>

async function fixture(body: (input: Parameters<typeof enrollFreshProbes>[0], calls: string[], operations: EnrollOperations) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-ensure-reference-'))
  const calls: string[] = []
  const input = {
    model: 'model-a', banksDir: directory, referencesDir: join(directory, 'references'), maxRequests: 10,
    config: { referenceMaxRequestsPerBuild: 20, referenceEndpoint: {
      baseUrl: 'https://reference.test', sourceId: 'test', trust: 'trusted' as const,
    } },
  }
  const operations: EnrollOperations = {
    loadSeed: async () => { calls.push('seed'); return referenceFixture('model-a', 100) },
    loadIndex: async () => { calls.push('index'); return { contrastModels: ['contrast-x'], probeIds: ['banked-1', 'banked-2'] } },
    catalog: async () => { calls.push('catalog'); return null },
    build: async (options) => {
      calls.push('build')
      // The run's 10 requests per build, within the configured total of 20.
      assert.equal(options.config?.referenceMaxRequestsPerBuild, 20)
      assert.equal(options.maxNewRequests, 10)
      return { reference: referenceFixture('model-a', 110), path: 'reference.json',
        cost: { totalUsdMicros: '1', requestCount: 1, models: [], purposes: [] },
        finalize: async () => { calls.push('finalize') } }
    },
    append: async () => { calls.push('append'); return { path: 'bank.json', addedProbeCount: 10, addedProbeIds: Array.from({ length: 10 }, (_, index) => `new-${index}`), canonicalConflictProbeCount: 0, totalProbeCount: 110 } },
  }
  try { await body(input, calls, operations) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('fresh enrollment builds a new reference that excludes every banked probe', async () => fixture(async (input, calls, operations) => {
  operations.build = async (options) => {
    calls.push('build')
    assert.equal(options.initialReference, undefined)
    // The bank's enrollment supplies the request settings, not probes to reuse.
    assert.equal(options.settingsReference?.referenceModel, 'model-a')
    assert.deepEqual([...(options.excludedProbeIds ?? [])], ['banked-1', 'banked-2'])
    assert.deepEqual(options.config?.models?.['model-a']?.contrastModels, ['contrast-x'])
    assert.equal(options.config?.referenceMaxRequestsPerBuild, 20)
    assert.equal(options.maxNewRequests, 10)
    return { reference: referenceFixture('model-a', 100), path: 'reference.json',
      cost: { totalUsdMicros: '3000000', requestCount: 1, models: [], purposes: [] },
      finalize: async () => { calls.push('finalize') } }
  }
  const enrolled = await enrollFreshProbes(input, operations)
  assert.deepEqual(calls, ['index', 'seed', 'catalog', 'build', 'append', 'finalize'])
  assert.equal(enrolled.addedProbeCount, 10)
}))

test('fresh enrollment needs an explicit budget before any call', async () => fixture(async (input, calls, operations) => {
  await assert.rejects(enrollFreshProbes({ ...input, maxRequests: 0 }, operations), /explicit positive/)
  assert.deepEqual(calls, [])
}))

const SET = { reference: { probes: [] }, extensions: [], candidateProbeCount: 0, previouslyAskedProbeCount: 0 } as unknown as EpochQuestionSetV1

function setOperations(selections: EpochQuestionSetSelection[], calls: string[], options: { banked?: number; added?: number[] } = {}) {
  const added = [...(options.added ?? [])]
  return {
    inspect: async () => ({ totalProbeCount: options.banked ?? 100, eligibleProbeCount: 0, selectedProbeCount: null, statisticalPower: null }),
    select: async () => { calls.push('select'); return selections.shift() ?? { status: 'short' as const, reason: 'still short', candidateProbeCount: 0 } },
    enrollFresh: async () => {
      calls.push('build')
      const count = added.shift() ?? 10
      return { addedProbeCount: count, addedProbeIds: Array.from({ length: count }, (_, index) => `p${calls.length}-${index}`), costUsdMicros: '1' }
    },
    record: async (input: { probeIds: readonly string[] }) => { calls.push(`record:${input.probeIds.length}`); return [...input.probeIds] },
  }
}

const setInput = {
  model: 'model-a', banksDir: '/banks', referencesDir: '/references', config: undefined, maxRequests: 10,
  epoch: '7', runId: 'run-a', extensionCount: 2,
}

test('an epoch question set already made is used as it is, with no build', async () => {
  const calls: string[] = []
  assert.equal(await ensureEpochQuestionSet(setInput, setOperations([{ status: 'ready', set: SET }], calls)), SET)
  assert.deepEqual(calls, ['select'])
})

test('new questions are built and recorded for the epoch until they make its question set', async () => {
  const calls: string[] = []
  const short = { status: 'short' as const, reason: 'short', candidateProbeCount: 0 }
  const set = await ensureEpochQuestionSet(setInput, setOperations([short, short, { status: 'ready', set: SET }], calls))
  assert.equal(set, SET)
  assert.deepEqual(calls, ['select', 'build', 'record:10', 'select', 'build', 'record:10', 'select'])
})

test('a model without a bank builds its first questions before selecting', async () => {
  const calls: string[] = []
  await ensureEpochQuestionSet(setInput, setOperations([{ status: 'ready', set: SET }], calls, { banked: 0 }))
  assert.deepEqual(calls, ['build', 'record:10', 'select'])
})

test('no question set after the build limit, or a build that adds nothing, means no audit of the model', async () => {
  const calls: string[] = []
  await assert.rejects(ensureEpochQuestionSet(setInput, setOperations([], calls)), /no question set for epoch 7: still short/)
  assert.equal(calls.filter((call) => call === 'build').length, EPOCH_SET_BUILD_ROUNDS)
  const empty: string[] = []
  await assert.rejects(ensureEpochQuestionSet(setInput, setOperations([], empty, { added: [0] })), /no question set for epoch 7/)
  assert.equal(empty.filter((call) => call === 'build').length, 1)
  await assert.rejects(ensureEpochQuestionSet({ ...setInput, maxRequests: 0 }, setOperations([], [])), /explicit positive/)
})

test('a run spends its budget per build; the build total is the configured one or several runs\' budgets', () => {
  assert.deepEqual(buildRequestLimits(600, undefined), { perRun: 600, total: 600 * BUILD_REQUEST_RUNS })
  assert.deepEqual(buildRequestLimits(600, 1000), { perRun: 600, total: 1000 })
  assert.deepEqual(buildRequestLimits(600, 400), { perRun: 400, total: 400 })
})

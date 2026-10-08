import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ensureAuditableReference } from './ensure-auditable-reference.js'
import { referenceFixture } from './audit-report-fixtures.test-support.js'

async function fixture(body: (input: Parameters<typeof ensureAuditableReference>[0], calls: string[], operations: NonNullable<Parameters<typeof ensureAuditableReference>[1]>) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-ensure-reference-'))
  const calls: string[] = []
  const input = {
    model: 'model-a', banksDir: directory, referencesDir: join(directory, 'references'), maxRequests: 10,
    config: { referenceMaxRequestsPerBuild: 20, referenceEndpoint: {
      baseUrl: 'https://reference.test', sourceId: 'test', trust: 'trusted' as const,
      models: { 'model-a': { upstreamModel: 'upstream-a' } },
    } },
  }
  let inspections = 0
  const operations: NonNullable<Parameters<typeof ensureAuditableReference>[1]> = {
    inspect: async () => {
      calls.push('inspect')
      return { totalProbeCount: 100, eligibleProbeCount: 100, selectedProbeCount: inspections++ ? 100 : null, statisticalPower: 0.95 }
    },
    loadSeed: async () => { calls.push('seed'); return referenceFixture('model-a', 100) },
    catalog: async () => { calls.push('catalog'); return null },
    build: async (options) => {
      calls.push('build')
      assert.equal(options.config?.referenceMaxRequestsPerBuild, 10)
      assert.ok(options.initialReference)
      return { reference: referenceFixture('model-a', 110), path: 'reference.json',
        cost: { totalUsdMicros: '1', requestCount: 1, models: [], purposes: [] },
        finalize: async () => { calls.push('finalize') } }
    },
    append: async () => { calls.push('append'); return { path: 'bank.json', addedProbeCount: 10, canonicalConflictProbeCount: 0, totalProbeCount: 110 } },
  }
  try { await body(input, calls, operations) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('enrollment appends then rechecks readiness before finalizing', async () => fixture(async (input, calls, operations) => {
  const original = JSON.stringify(input.config)
  await ensureAuditableReference(input, operations)
  assert.deepEqual(calls, ['inspect', 'seed', 'catalog', 'build', 'append', 'inspect', 'finalize'])
  assert.equal(JSON.stringify(input.config), original)
}))

test('a ready bank makes no reference or catalog calls', async () => fixture(async (input, calls, operations) => {
  operations.inspect = async () => ({ totalProbeCount: 100, eligibleProbeCount: 100, selectedProbeCount: 100, statisticalPower: 0.95 })
  await ensureAuditableReference(input, operations)
  assert.deepEqual(calls, [])
}))

test('failed readiness after append blocks audit and keeps checkpoint', async () => fixture(async (input, calls, operations) => {
  operations.inspect = async () => ({ totalProbeCount: 100, eligibleProbeCount: 100, selectedProbeCount: null, statisticalPower: null })
  await assert.rejects(ensureAuditableReference(input, operations), /no seller audit started/)
  assert.equal(calls.includes('finalize'), false)
}))

test('budget exhaustion preserves bank and releases the enrollment lock', async () => fixture(async (input, calls, operations) => {
  operations.build = async () => { throw new Error('request budget exhausted') }
  await assert.rejects(ensureAuditableReference(input, operations), /request budget exhausted/)
  assert.equal(calls.includes('append'), false)
  assert.equal(calls.includes('finalize'), false)
  await ensureAuditableReference(input, operations)
}))

test('missing explicit budget fails before inspection or paid calls', async () => fixture(async (input, calls, operations) => {
  await assert.rejects(ensureAuditableReference({ ...input, maxRequests: 0 }, operations), /explicit positive/)
  assert.deepEqual(calls, [])
}))

test('incompatible banks fail before catalog or build calls', async () => fixture(async (input, calls, operations) => {
  operations.loadSeed = async () => { throw new Error('incompatible bank') }
  await assert.rejects(ensureAuditableReference(input, operations), /incompatible bank/)
  assert.deepEqual(calls, ['inspect'])
}))

test('top-up preserves existing contrasts rather than choosing easier substitutes', async () => fixture(async (input, calls, operations) => {
  const seed = referenceFixture('model-a', 100)
  seed.contrasts = [{ model: 'difficult-contrast', distinguishingProbeIds: [] }]
  operations.loadSeed = async () => seed
  const build = operations.build
  operations.build = async (options) => {
    assert.deepEqual(options.config!.referenceEndpoint!.models['model-a']!.contrastModels, ['difficult-contrast'])
    return build(options)
  }
  await ensureAuditableReference(input, operations)
  assert.equal(calls.includes('finalize'), true)
}))

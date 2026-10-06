import { describe, expect, it } from 'vitest'
import { auditEndpoint, selectProbes } from '../src/audit.js'
import { FakeEndpoint, testReference } from './fixtures.js'

describe('auditEndpoint', () => {
  it('returns SAME for an endpoint serving the reference model', async () => {
    const result = await auditEndpoint({ endpoint: new FakeEndpoint(), reference: testReference() })
    expect(result.evaluation.verdict).toBe('SAME')
    expect(result.evaluation.stats.targetHamming).toBe(0)
    expect(result.statisticalPower).toBeGreaterThanOrEqual(0.9)
    expect(result.batches.every((batch) => batch.status === 'succeeded')).toBe(true)
  })

  it('returns DIFF for a substitute that misses a share of the reference probes', async () => {
    const substitute = new FakeEndpoint((probeIndex) => probeIndex % 3 === 0)
    const result = await auditEndpoint({ endpoint: substitute, reference: testReference() })
    expect(result.evaluation.verdict).toBe('DIFF')
  })

  it('treats failed batches as missing, not wrong, and reports UNDETERMINED below coverage', async () => {
    const flaky = new FakeEndpoint(() => false, (callIndex) => callIndex % 2 === 0)
    const result = await auditEndpoint({ endpoint: flaky, reference: testReference(), probeCount: 100, concurrency: 1 })
    expect(result.evaluation.verdict).toBe('UNDETERMINED')
    expect(result.evaluation.matchVector.filter((entry) => entry === null)).toHaveLength(50)
    expect(result.evaluation.stats.targetHamming).toBe(0)
  })

  it('varies the prompt wording between batches', async () => {
    const endpoint = new FakeEndpoint()
    const result = await auditEndpoint({ endpoint, reference: testReference(), probeCount: 200 })
    expect(new Set(result.batches.map((batch) => batch.promptVariantId)).size).toBeGreaterThan(1)
    expect(result.evaluation.verdict).toBe('SAME')
  })

  it('sends canonical audit settings and the requested model', async () => {
    const endpoint = new FakeEndpoint()
    await auditEndpoint({ endpoint, reference: testReference(), model: 'vendor/open-model', probeCount: 20 })
    expect(endpoint.requests).toHaveLength(2)
    for (const request of endpoint.requests) {
      expect(request.model).toBe('vendor/open-model')
      expect(request.system.length).toBeGreaterThan(0)
      expect(request.temperature).toBe(0)
      expect(request.topP).toBe(1)
    }
  })
})

describe('selectProbes', () => {
  it('draws a fresh order per audit and stops at the smallest powered subset', () => {
    const reference = testReference()
    let seed = 1
    const draw = (max: number): number => {
      seed = (seed * 48271) % 2147483647
      return seed % max
    }
    const first = selectProbes(reference, { draw, minimumPower: 0.9 })
    const second = selectProbes(reference, { draw, minimumPower: 0.9 })
    expect(first.power).toBeGreaterThanOrEqual(0.9)
    expect(first.probes.length % 10).toBe(0)
    expect(first.probes.length).toBeLessThan(reference.probes.length)
    expect(first.probes.map((probe) => probe.id)).not.toEqual(second.probes.map((probe) => probe.id))
  })

  it('rejects probe counts that are not whole batches', () => {
    expect(() => selectProbes(testReference(), { draw: () => 0, minimumPower: 0.9, probeCount: 15 })).toThrow()
  })
})

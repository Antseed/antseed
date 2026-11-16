import assert from 'node:assert/strict'
import test from 'node:test'
import type { KbfProbe } from '@antseed/fingerprints'
import { createDomainHomogeneousKbfBatches } from './kbf-batching.js'

function probe(id: string, domain: string): KbfProbe {
  return {
    id,
    name: id,
    domain,
    template: `${id} is ___.`,
    consensus: 1,
    range: [0, 10],
    tolerance: { mode: 'absolute', value: 0 },
  }
}

test('domain batching never mixes domains and retains original indexes', () => {
  const probes = [probe('m1', 'math'), probe('c1', 'chemistry'), probe('m2', 'math'), probe('c2', 'chemistry')]
  const batches = createDomainHomogeneousKbfBatches(probes, 10, (values) => [...values])

  assert.deepEqual(batches.map((batch) => batch.probes.map((entry) => entry.id)), [
    ['m1', 'm2'],
    ['c1', 'c2'],
  ])
  assert.deepEqual(batches.map((batch) => batch.indexes), [[0, 2], [1, 3]])
  assert.equal(batches.every((batch) => new Set(batch.probes.map((entry) => entry.domain)).size === 1), true)
})

test('domain batching applies independent caller-provided order within domains', () => {
  const probes = [probe('m1', 'math'), probe('m2', 'math'), probe('m3', 'math')]
  const batches = createDomainHomogeneousKbfBatches(probes, 2, (values) => [...values].reverse())

  assert.deepEqual(batches.map((batch) => batch.probes.map((entry) => entry.id)), [['m3', 'm2'], ['m1']])
  assert.deepEqual(batches.map((batch) => batch.indexes), [[2, 1], [0]])
})

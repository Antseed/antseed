import assert from 'node:assert/strict'
import test from 'node:test'
import type { KbfProbe } from '@antseed/fingerprints'
import { createDomainHomogeneousKbfBatches, kbfAuditBatches } from './kbf-batching.js'

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

/** The batches every caller must produce for the same 30 questions (pinned; also in fingerprints and model-verifier). */
const PINNED_DOMAINS = ['math', 'law', 'math', 'bio']
const PINNED_BATCHES = [
  [0, 2, 4, 6, 8, 10, 12, 14, 16, 18],
  [20, 22, 24, 26, 28],
  [1, 5, 9, 13, 17, 21, 25, 29],
  [3, 7, 11, 15, 19, 23, 27],
]

test('audit batches of a question set are pinned: domains in first-seen order, set order inside, ten per request', () => {
  const probes = Array.from({ length: 30 }, (_, index) => probe(`q${index}`, PINNED_DOMAINS[index % 4]!))
  const batches = kbfAuditBatches(probes)
  assert.deepEqual(batches.map((batch) => batch.indexes), PINNED_BATCHES)
  assert.deepEqual(batches.map((batch) => batch.probes.map((entry) => entry.id)), PINNED_BATCHES.map((batch) => batch.map((index) => `q${index}`)))
})

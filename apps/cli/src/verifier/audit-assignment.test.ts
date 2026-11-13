import assert from 'node:assert/strict'
import test from 'node:test'
import { getAddress } from 'ethers'
import {
  assignAuditModels,
  assignAuditModelsRoundRobin,
  auditModelListHash,
  roundRobinAssignmentFor,
} from './audit-assignment.js'

const AUDITOR = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8'

test('assigns every available model, deduplicated and sorted, with a checksummed auditor', () => {
  const assignment = assignAuditModels({
    auditor: ` ${AUDITOR} `,
    epoch: '42',
    availableModels: ['model-b', 'model-a', 'MODEL-A', ' '],
  })
  assert.deepEqual(assignment, {
    auditor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
    epoch: '42',
    strategy: 'all',
    models: ['model-a', 'model-b'],
  })
})

test('assignment is deterministic for the same auditor and epoch', () => {
  const input = { auditor: AUDITOR, epoch: '7', availableModels: ['c', 'a', 'b'] }
  assert.deepEqual(assignAuditModels(input), assignAuditModels({ ...input, availableModels: ['b', 'c', 'a'] }))
})

test('rejects an invalid auditor address or an empty epoch', () => {
  assert.throws(() => assignAuditModels({ auditor: 'not-an-address', epoch: '1', availableModels: [] }))
  assert.throws(() => assignAuditModels({ auditor: AUDITOR, epoch: ' ', availableModels: [] }), /epoch/)
})

// ── Round robin: one model per auditor per epoch ─────────────────────────────

/** Seeded PRNG (mulberry32), so random auditor sets are reproducible when a test fails. */
function prng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomAddresses(random: () => number, count: number): string[] {
  return Array.from({ length: count }, () => {
    const bytes = Array.from({ length: 20 }, () => Math.floor(random() * 256))
    return getAddress('0x' + Buffer.from(bytes).toString('hex'))
  })
}

function shuffled<T>(random: () => number, values: readonly T[]): T[] {
  const copy = [...values]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy
}

function randomInt(random: () => number, min: number, max: number): number {
  return min + Math.floor(random() * (max - min + 1))
}

const modelNames = (count: number) => Array.from({ length: count }, (_, index) => `model-${String(index).padStart(2, '0')}`)

/** The built-in list size at the time of writing; the property tests also cover every other size. */
const MODELS = modelNames(19)

/** Model -> its auditor for one epoch, failing if any model has zero or several auditors. */
function auditorByModel(input: Parameters<typeof assignAuditModelsRoundRobin>[0]): Map<string, string> {
  const owners = new Map<string, string>()
  for (const { auditor, models, strategy } of assignAuditModelsRoundRobin(input)) {
    assert.equal(strategy, 'round-robin')
    for (const model of models) {
      assert.equal(owners.has(model), false, `${model} assigned to both ${owners.get(model)} and ${auditor}`)
      owners.set(model, auditor)
    }
  }
  return owners
}

function modelsByAuditor(input: Parameters<typeof assignAuditModelsRoundRobin>[0]): Map<string, string[]> {
  return new Map(assignAuditModelsRoundRobin(input).map((entry) => [entry.auditor, entry.models]))
}

test('round robin: a fixed example, 3 auditors and 5 models', () => {
  const auditors = [
    '0xcccccccccccccccccccccccccccccccccccccccc',
    '0x1111111111111111111111111111111111111111',
    '0x7777777777777777777777777777777777777777',
  ]
  const availableModels = ['e', 'a', 'd', 'b', 'c']
  const row = (epoch: number) => assignAuditModelsRoundRobin({ auditors, epoch, availableModels }).map((entry) => entry.models)
  // Columns are the auditors in address order: 0x1111…, 0x7777…, 0xcccc….
  assert.deepEqual(row(0), [['a', 'd'], ['b', 'e'], ['c']])
  assert.deepEqual(row(1), [['c'], ['a', 'd'], ['b', 'e']])
  assert.deepEqual(row(2), [['b', 'e'], ['c'], ['a', 'd']])
  assert.deepEqual(row(3), row(0), 'the rotation repeats every auditorCount epochs')
  assert.deepEqual(assignAuditModelsRoundRobin({ auditors, epoch: '0', availableModels }).map((entry) => entry.auditor), [
    '0x1111111111111111111111111111111111111111',
    '0x7777777777777777777777777777777777777777',
    '0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC',
  ])
})

test('round robin: with random auditors, every model is audited every epoch by exactly one auditor', () => {
  const random = prng(0xa11ce)
  for (let trial = 0; trial < 300; trial++) {
    const modelCount = randomInt(random, 1, 40)
    const auditors = randomAddresses(random, randomInt(random, 1, modelCount))
    const availableModels = modelNames(modelCount)
    const start = randomInt(random, 0, 1_000_000)
    for (let epoch = start; epoch < start + 2 * auditors.length + 1; epoch++) {
      const owners = auditorByModel({ auditors, epoch, availableModels })
      assert.deepEqual([...owners.keys()].sort(), availableModels, `trial ${trial}, epoch ${epoch}: a model was left out`)
    }
  }
})

test('round robin: auditors get floor or ceil of models / auditors each, every auditor at least one', () => {
  const random = prng(0xb0b)
  for (let trial = 0; trial < 300; trial++) {
    const modelCount = randomInt(random, 1, 40)
    const auditors = randomAddresses(random, randomInt(random, 1, modelCount))
    const epoch = randomInt(random, 0, 1_000_000)
    const loads = [...modelsByAuditor({ auditors, epoch, availableModels: modelNames(modelCount) }).values()].map((models) => models.length)
    assert.equal(loads.length, auditors.length)
    assert.equal(loads.reduce((sum, load) => sum + load, 0), modelCount)
    assert.ok(Math.min(...loads) >= Math.floor(modelCount / auditors.length) && Math.min(...loads) >= 1, `trial ${trial}: loads ${loads.join(',')}`)
    assert.ok(Math.max(...loads) <= Math.ceil(modelCount / auditors.length), `trial ${trial}: loads ${loads.join(',')}`)
  }
})

test('round robin: with two or more auditors, nobody keeps a model into the next epoch', () => {
  const random = prng(0xbeef)
  for (let trial = 0; trial < 200; trial++) {
    const modelCount = randomInt(random, 2, 40)
    const auditors = randomAddresses(random, randomInt(random, 2, modelCount))
    const availableModels = modelNames(modelCount)
    const start = randomInt(random, 0, 1_000_000)
    let previous = auditorByModel({ auditors, epoch: start, availableModels })
    for (let epoch = start + 1; epoch < start + 2 * auditors.length; epoch++) {
      const current = auditorByModel({ auditors, epoch, availableModels })
      for (const model of availableModels) {
        assert.notEqual(current.get(model), previous.get(model), `trial ${trial}, epoch ${epoch}: ${model} kept its auditor`)
      }
      previous = current
    }
  }
})

test('round robin: over auditorCount epochs every auditor audits every model exactly once', () => {
  const random = prng(0xcafe)
  for (let trial = 0; trial < 200; trial++) {
    const modelCount = randomInt(random, 1, 30)
    const auditors = randomAddresses(random, randomInt(random, 1, modelCount))
    const availableModels = modelNames(modelCount)
    const start = randomInt(random, 0, 1_000_000)
    const seen = new Map<string, number>()
    for (let epoch = start; epoch < start + auditors.length; epoch++) {
      for (const [auditor, models] of modelsByAuditor({ auditors, epoch, availableModels })) {
        for (const model of models) seen.set(`${auditor}/${model}`, (seen.get(`${auditor}/${model}`) ?? 0) + 1)
      }
    }
    assert.equal(seen.size, auditors.length * modelCount, `trial ${trial}: every auditor/model pair`)
    assert.ok([...seen.values()].every((count) => count === 1), `trial ${trial}: each pair exactly once`)
  }
})

test('round robin: every auditor/model count up to 24, exhaustively', () => {
  const auditorPool = randomAddresses(prng(0x5eed), 24)
  for (let modelCount = 1; modelCount <= 24; modelCount++) {
    const availableModels = modelNames(modelCount)
    for (let auditorCount = 1; auditorCount <= 24; auditorCount++) {
      const auditors = auditorPool.slice(0, auditorCount)
      for (let epoch = 0; epoch < auditorCount + 1; epoch++) {
        assert.equal(auditorByModel({ auditors, epoch, availableModels }).size, modelCount, `${auditorCount} auditors, ${modelCount} models, epoch ${epoch}`)
      }
    }
  }
})

test('round robin: with more auditors than models, the auditors without a model change every epoch', () => {
  const auditors = randomAddresses(prng(0xd00d), 7)
  const availableModels = ['model-a', 'model-b', 'model-c']
  const idle = (epoch: number) => assignAuditModelsRoundRobin({ auditors, epoch, availableModels })
    .filter((entry) => entry.models.length === 0)
    .map((entry) => entry.auditor)
  const idleSets = new Set<string>()
  for (let epoch = 0; epoch < auditors.length; epoch++) {
    assert.equal(idle(epoch).length, 4)
    assert.equal(auditorByModel({ auditors, epoch, availableModels }).size, 3)
    assert.notDeepEqual(idle(epoch), idle(epoch + 1))
    idleSets.add(idle(epoch).join(','))
  }
  assert.equal(idleSets.size, auditors.length)
})

test('round robin: auditor order, case and duplicates do not change the split', () => {
  const random = prng(0xfeed)
  for (let trial = 0; trial < 100; trial++) {
    const auditors = randomAddresses(random, randomInt(random, 1, 12))
    const epoch = randomInt(random, 0, 500)
    const baseline = assignAuditModelsRoundRobin({ auditors, epoch, availableModels: MODELS })
    const noisy = shuffled(random, [
      ...auditors.map((address) => address.toLowerCase()),
      ...auditors.slice(0, 2).map((address) => ` ${address.toUpperCase().replace('0X', '0x')} `),
    ])
    const noisyModels = shuffled(random, [...MODELS, MODELS[3]!, ` ${MODELS[1]} `, ' '])
    assert.deepEqual(assignAuditModelsRoundRobin({ auditors: noisy, epoch: String(epoch), availableModels: noisyModels }), baseline)
  }
})

test('round robin: one auditor audits every model every epoch', () => {
  const [only] = randomAddresses(prng(1), 1)
  for (const epoch of [0, 1, 99]) {
    assert.deepEqual(modelsByAuditor({ auditors: [only!], epoch, availableModels: MODELS }).get(only!), MODELS)
  }
})

test('round robin: roundRobinAssignmentFor matches the full split and rejects outsiders', () => {
  const random = prng(2)
  const auditors = randomAddresses(random, 5)
  const input = { auditors, epoch: 123n, availableModels: MODELS }
  for (const entry of assignAuditModelsRoundRobin(input)) {
    assert.deepEqual(roundRobinAssignmentFor(entry.auditor.toLowerCase(), input), entry)
  }
  const [outsider] = randomAddresses(random, 1)
  assert.throws(() => roundRobinAssignmentFor(outsider!, input), /not an approved auditor/)
})

test('round robin: large epochs work, and bad input is rejected', () => {
  const auditors = randomAddresses(prng(3), 4)
  const huge = 2n ** 200n + 1n
  const assignments = assignAuditModelsRoundRobin({ auditors, epoch: huge, availableModels: MODELS })
  assert.equal(assignments[0]!.epoch, huge.toString())
  assert.deepEqual(assignments, assignAuditModelsRoundRobin({ auditors, epoch: 1, availableModels: MODELS }).map((entry) => ({ ...entry, epoch: huge.toString() })))

  assert.throws(() => assignAuditModelsRoundRobin({ auditors: [], epoch: 1, availableModels: MODELS }), /at least one approved auditor/)
  assert.throws(() => assignAuditModelsRoundRobin({ auditors, epoch: 1, availableModels: [' '] }), /at least one audited model/)
  assert.throws(() => assignAuditModelsRoundRobin({ auditors: ['0x1234'], epoch: 1, availableModels: MODELS }))
  for (const epoch of ['-1', '1.5', '', ' ', 'abc', '2026-10-28', -1]) {
    assert.throws(() => assignAuditModelsRoundRobin({ auditors, epoch, availableModels: MODELS }), /non-negative integer on-chain epoch/)
  }
})

test('model list hash ignores order, case and duplicates, and changes with the list', () => {
  assert.equal(auditModelListHash(['b', 'A', 'a']), auditModelListHash(['a', 'b']))
  assert.notEqual(auditModelListHash(['a', 'b']), auditModelListHash(['a', 'b', 'c']))
})

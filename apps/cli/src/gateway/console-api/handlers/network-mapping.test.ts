import assert from 'node:assert/strict'
import test from 'node:test'
import { trustBreakdownField } from './network-mapping.js'

test('trustBreakdownField maps the current buyer format, with history left unscored', () => {
  const { trustBreakdown } = trustBreakdownField({
    history: { score: 0, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 },
    usage: { score: 12 },
    power: { score: 44 },
    verification: { multiplierBps: 10_200, sameCount: 9, diffCount: 2, change: 1.2, penalty: 0 },
  })
  assert.deepEqual(trustBreakdown, {
    usage: 12,
    power: 44,
    identity: null,
    freeModels: null,
    verification: { multiplierBps: 10_200, sameCount: 9, diffCount: 2, change: 1.2 },
  })
})

test('trustBreakdownField keeps the history score and penalty of an older buyer daemon', () => {
  const { trustBreakdown } = trustBreakdownField({
    history: { score: 50, channelCount: 100, totalVolumeUsdcMicros: 100_000_000 },
    usage: { score: 12 },
    verification: { multiplierBps: 4_000, sameCount: 2, diffCount: 4, penalty: 30 },
  })
  assert.equal(trustBreakdown?.history, 50)
  assert.deepEqual(trustBreakdown?.verification, { multiplierBps: 4_000, sameCount: 2, diffCount: 4, change: -30 })
})

test('trustBreakdownField returns nothing for an empty breakdown', () => {
  assert.deepEqual(trustBreakdownField({}), {})
})

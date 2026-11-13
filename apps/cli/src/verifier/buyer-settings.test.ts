import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRunningBuyerSettings } from './buyer-settings.js'

test('the running buyer\'s recorded limits are parsed', () => {
  assert.deepEqual(parseRunningBuyerSettings({
    configPath: '/c.json',
    minPeerReputation: 5,
    maxPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50, cachedInputUsdPerMillion: 2 },
    maxReserveAmountUsdc: '1000000',
  }), {
    minPeerReputation: 5,
    maxPricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 50, cachedInputUsdPerMillion: 2 },
    maxReserveAmountUsdc: 1_000_000n,
  })
})

test('a buyer that records no or broken limits gives null values', () => {
  assert.equal(parseRunningBuyerSettings(undefined), null)
  assert.deepEqual(parseRunningBuyerSettings({ minPeerReputation: 'x', maxPricing: { inputUsdPerMillion: 1 } }), {
    minPeerReputation: null,
    maxPricing: null,
    maxReserveAmountUsdc: null,
  })
})

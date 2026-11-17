import assert from 'node:assert/strict'
import test from 'node:test'
import { chainNow } from './chain-clock.js'

test('chainNow is the latest block’s timestamp, whatever the wall clock says', async () => {
  assert.equal(await chainNow({ getBlock: async () => ({ timestamp: 1_000 }) }, 5_000_000), 1_000)
  assert.equal(await chainNow({ getBlock: async () => ({ timestamp: 9_000 }) }, 5_000_000), 9_000)
})

test('chainNow falls back to the wall clock when the block cannot be read', async () => {
  assert.equal(await chainNow({ getBlock: async () => null }, 5_000_999), 5_000)
  assert.equal(await chainNow({ getBlock: async () => { throw new Error('rpc down') } }, 5_000_999), 5_000)
})

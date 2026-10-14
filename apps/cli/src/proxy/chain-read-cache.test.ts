import assert from 'node:assert/strict'
import test from 'node:test'
import { ChainReadCache } from './chain-read-cache.js'

test('a value is reused for its TTL and concurrent loads share one call', async () => {
  let now = 0
  let loads = 0
  const cache = new ChainReadCache({ now: () => now })
  const load = async () => { loads++; return loads }
  const [a, b] = await Promise.all([cache.read('k', { ttlMs: 1_000 }, load), cache.read('k', { ttlMs: 1_000 }, load)])
  assert.equal(a.value, 1)
  assert.equal(b.value, 1)
  now = 999
  assert.equal((await cache.read('k', { ttlMs: 1_000 }, load)).value, 1)
  now = 1_000
  assert.equal((await cache.read('k', { ttlMs: 1_000 }, load)).value, 2)
  assert.equal(loads, 2)
})

test('stale-while-revalidate answers at once and refreshes in the background, within its window only', async () => {
  let now = 0
  let loads = 0
  const cache = new ChainReadCache({ now: () => now })
  const load = async () => ++loads
  await cache.read('k', { ttlMs: 100, staleWhileRevalidateMs: 1_000 }, load)
  now = 500
  const served = await cache.read('k', { ttlMs: 100, staleWhileRevalidateMs: 1_000 }, load)
  assert.deepEqual([served.value, served.stale], [1, false])
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(loads, 2)
  assert.equal(cache.peek('k')?.value, 2)
  now = 5_000 // past TTL + window: wait for the read
  assert.equal((await cache.read('k', { ttlMs: 100, staleWhileRevalidateMs: 1_000 }, load)).value, 3)
})

test('a failed refresh serves the last value as stale and does not retry until errorRetryMs passes', async () => {
  let now = 0
  let loads = 0
  let fail = false
  const cache = new ChainReadCache({ now: () => now, errorRetryMs: 10_000 })
  const load = async () => {
    loads++
    if (fail) throw new Error('429')
    return 'v'
  }
  await cache.read('k', { ttlMs: 100 }, load)
  fail = true
  now = 200
  assert.deepEqual(await cache.read('k', { ttlMs: 100 }, load), { value: 'v', stale: true, fetchedAt: 0 })
  assert.equal(loads, 2)
  now = 5_000
  assert.equal((await cache.read('k', { ttlMs: 100 }, load)).stale, true)
  assert.equal(loads, 2, 'no retry inside the error window')
  now = 10_201
  fail = false
  assert.deepEqual(await cache.read('k', { ttlMs: 100 }, load), { value: 'v', stale: false, fetchedAt: 10_201 })
  assert.equal(loads, 3)
})

test('a failure without a cached value is rethrown (and not retried at once)', async () => {
  let loads = 0
  const cache = new ChainReadCache({ now: () => 0, errorRetryMs: 10_000 })
  const load = async () => { loads++; throw new Error('down') }
  await assert.rejects(cache.read('k', { ttlMs: 100 }, load), /down/)
  await assert.rejects(cache.read('k', { ttlMs: 100 }, load), /down/)
  assert.equal(loads, 1)
})

test('set, force and invalidate', async () => {
  let loads = 0
  const cache = new ChainReadCache({ now: () => 0 })
  cache.set('usdc:0xabc', 5n)
  assert.equal((await cache.read('usdc:0xabc', { ttlMs: 100 }, async () => { loads++; return 6n })).value, 5n)
  assert.equal((await cache.read('usdc:0xabc', { ttlMs: 100, force: true }, async () => { loads++; return 6n })).value, 6n)
  cache.invalidate('usdc')
  assert.equal(cache.peek('usdc:0xabc'), null)
  assert.equal(loads, 1)
})

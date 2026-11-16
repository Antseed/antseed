import assert from 'node:assert/strict'
import test from 'node:test'
import { BackgroundValue } from './background.js'
import { standingTtlMs } from './standing.js'

const tick = () => new Promise((resolve) => setImmediate(resolve))

test('reads never wait, loads are single-flight and only happen when stale', async () => {
  let now = 0
  let loads = 0
  let release: () => void = () => {}
  const value = new BackgroundValue(() => new Promise<number>((resolve) => { loads += 1; release = () => resolve(loads) }), { ttlMs: 1_000, now: () => now })
  assert.equal(value.read().value, null)
  value.read()
  value.read(true)
  assert.equal(loads, 1, 'concurrent reads share one load')
  release()
  await tick()
  assert.equal(value.read().value, 1)
  now = 999
  value.read()
  assert.equal(loads, 1, 'fresh: no load')
  now = 1_000
  value.read()
  assert.equal(loads, 2, 'stale: one background load')
})

test('failures back off exponentially; a forced refresh is rate-limited', async () => {
  let now = 0
  let fail = true
  const value = new BackgroundValue(async () => { if (fail) throw new Error('429'); return 'ok' }, { ttlMs: 60_000, backoffMs: 1_000, maxBackoffMs: 4_000, minRefreshMs: 30_000, now: () => now })
  const attempts = () => value.loads
  value.read(); await tick()
  assert.equal(value.read().error, '429')
  now = 500; value.read(); await tick()
  assert.equal(attempts(), 1, 'inside the first back-off')
  now = 1_000; value.read(); await tick()
  assert.equal(attempts(), 2)
  now = 2_500; value.read(); await tick()
  assert.equal(attempts(), 2, 'back-off doubled to 2 s')
  now = 3_000; value.read(); await tick()
  assert.equal(attempts(), 3)
  fail = false
  now = 7_000; value.read(); await tick()
  assert.equal(value.read().value, 'ok')
  now = 8_000; value.read(true); await tick()
  assert.equal(attempts(), 4, 'forced refresh inside 30 s is ignored')
  now = 37_000; value.read(true); await tick()
  assert.equal(attempts(), 5)
})

test('values can expire at a known time, e.g. the end of the epoch', async () => {
  let now = 0
  const value = new BackgroundValue(async () => ({ epochEndsAt: 5 * 60_000 }), { ttlMs: (read, at) => read.epochEndsAt - at, now: () => now })
  await value.get()
  now = 4 * 60_000; value.read(); await tick()
  assert.equal(value.loads, 1)
  now = 5 * 60_000; value.read(); await tick()
  assert.equal(value.loads, 2)
})

test('standing is reused until the epoch ends, between 2 and 30 minutes', () => {
  const read = (epochEndsAt: number | null) => ({ epochEndsAt, standing: {} as never })
  assert.equal(standingTtlMs(read(null), 0), 30 * 60_000)
  assert.equal(standingTtlMs(read(10 * 60_000), 0), 10 * 60_000)
  assert.equal(standingTtlMs(read(30_000), 0), 2 * 60_000)
  assert.equal(standingTtlMs(read(5 * 3_600_000), 0), 30 * 60_000)
})

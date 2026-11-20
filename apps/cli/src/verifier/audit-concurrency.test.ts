import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ConcurrencyLimiter,
  KeyedSerialLimiter,
  mapConcurrently,
  mapInLanes,
  mapWithAdaptiveConcurrency,
} from './audit-concurrency.js'

test('concurrency limiter bounds active tasks', async () => {
  const limiter = new ConcurrencyLimiter(3)
  let active = 0
  let maximum = 0
  await Promise.all(Array.from({ length: 12 }, () => limiter.run(async () => {
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    active -= 1
  })))
  assert.equal(maximum, 3)
})

test('keyed limiter serializes equal keys but overlaps different keys', async () => {
  const limiter = new KeyedSerialLimiter()
  const active = new Map<string, number>()
  let sameKeyMaximum = 0
  let totalActive = 0
  let totalMaximum = 0
  await Promise.all(['seller-a', 'seller-a', 'seller-b'].map((key) => limiter.run(key, async () => {
    active.set(key, (active.get(key) ?? 0) + 1)
    sameKeyMaximum = Math.max(sameKeyMaximum, active.get(key)!)
    totalActive += 1
    totalMaximum = Math.max(totalMaximum, totalActive)
    await new Promise((resolve) => setTimeout(resolve, 5))
    totalActive -= 1
    active.set(key, active.get(key)! - 1)
  })))
  assert.equal(sameKeyMaximum, 1)
  assert.equal(totalMaximum, 2)
})

test('concurrent mapping preserves input order', async () => {
  const results = await mapConcurrently([3, 1, 2], 3, async (value) => {
    await new Promise((resolve) => setTimeout(resolve, value))
    return value * 2
  })
  assert.deepEqual(results, [6, 2, 4])
})

test('adaptive mapping starts serially and promotes after a healthy first result', async () => {
  let active = 0
  let maximum = 0
  const starts: Array<{ index: number; active: number }> = []
  const results = await mapWithAdaptiveConcurrency(
    [0, 1, 2, 3],
    2,
    async (value, index) => {
      active += 1
      maximum = Math.max(maximum, active)
      starts.push({ index, active })
      await new Promise((resolve) => setTimeout(resolve, 5))
      active -= 1
      return value
    },
    (_result, index) => index === 0,
  )
  assert.deepEqual(results, [0, 1, 2, 3])
  assert.deepEqual(starts[0], { index: 0, active: 1 })
  assert.equal(maximum, 2)
})

test('adaptive mapping permanently reduces to one after rate limiting', async () => {
  let active = 0
  const starts: Array<{ index: number; active: number }> = []
  await mapWithAdaptiveConcurrency(
    [0, 1, 2, 3, 4, 5],
    2,
    async (value, index, control) => {
      active += 1
      starts.push({ index, active })
      if (index === 1) control.reduceToOne()
      await new Promise((resolve) => setTimeout(resolve, index === 1 ? 2 : 5))
      active -= 1
      return value
    },
    (_result, index) => index === 0,
  )
  const startsAfterReduction = starts.filter(({ index }) => index >= 3)
  assert.equal(startsAfterReduction.every(({ active: count }) => count === 1), true)
})

test('a slow prepare does not delay another lane\'s execute', async () => {
  let releaseSlow!: () => void
  const slow = new Promise<void>((resolve) => { releaseSlow = resolve })
  const order: string[] = []
  await mapInLanes(['slow', 'fast'], 1, async (item) => {
    if (item === 'slow') await slow
    return item
  }, async (item) => {
    order.push(item)
    // The slow lane is released only by the fast lane's execute, so waiting for it would never end.
    if (item === 'fast') releaseSlow()
  })
  assert.deepEqual(order, ['fast', 'slow'])
})

test('lanes hold a slot only for execute, and the cap holds', async () => {
  let active = 0
  let maximum = 0
  let prepared = 0
  await mapInLanes(Array.from({ length: 8 }, (_, index) => index), 2, async (item) => {
    prepared += 1
    return item
  }, async () => {
    // Every prepare runs before the first execute ends, whatever the cap.
    active += 1
    maximum = Math.max(maximum, active)
    await new Promise((resolve) => setTimeout(resolve, 2))
    active -= 1
    assert.equal(prepared, 8)
  })
  assert.equal(maximum, 2)
})

test('lanes keep item order and leave out items prepare declined', async () => {
  const results = await mapInLanes(['a', 'skip', 'b', 'c'], 4, async (item, index) => {
    await new Promise((resolve) => setTimeout(resolve, 8 - index * 2))
    return item === 'skip' ? null : item
  }, async (item, index) => `${item}${index}`)
  assert.deepEqual(results, ['a0', 'b2', 'c3'])
})

test('a lane failure is rethrown only after the other lanes end', async () => {
  const finished: string[] = []
  await assert.rejects(mapInLanes(['fails', 'slow'], 2, async (item) => {
    if (item === 'fails') throw new Error('prepare failed')
    return item
  }, async (item) => {
    await new Promise((resolve) => setTimeout(resolve, 10))
    finished.push(item)
  }), /prepare failed/)
  assert.deepEqual(finished, ['slow'])

  await assert.rejects(mapInLanes(['fails', 'slow'], 2, async (item) => item, async (item) => {
    if (item === 'fails') throw new Error('execute failed')
    await new Promise((resolve) => setTimeout(resolve, 10))
    finished.push(`${item} again`)
  }), /execute failed/)
  assert.deepEqual(finished, ['slow', 'slow again'])
})

test('lanes reject an invalid slot count', async () => {
  await assert.rejects(mapInLanes(['a'], 0, async (item) => item, async (item) => item), /integer >= 1/)
})

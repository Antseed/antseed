import assert from 'node:assert/strict'
import test from 'node:test'
import type { RetailPriceMap } from '@antseed/node/retail-prices'
import { createReferencePriceSource } from './reference-prices.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))
const priceList = (input: number): RetailPriceMap => new Map([['example-model', { input, output: 2, cachedInput: null }]])

test('a read never waits for the price list: it answers what is held and refreshes behind it', async () => {
  let clock = 0
  let reads = 0
  const source = createReferencePriceSource({ fetchPrices: async () => priceList(++reads), now: () => clock })

  assert.equal(source.current(), null)
  await settle()
  assert.equal(source.current()?.get('example-model')?.input, 1)
  assert.equal(reads, 1)

  clock += 10 * 60_000
  assert.equal(source.current()?.get('example-model')?.input, 1)
  await settle()
  assert.equal(source.current()?.get('example-model')?.input, 2)
  assert.equal(reads, 2)
})

test('a failed refresh keeps the last good prices and is retried after a minute', async () => {
  let clock = 0
  const answers: Array<RetailPriceMap | null | Error> = [priceList(1), new Error('offline'), null, priceList(4)]
  let reads = 0
  const source = createReferencePriceSource({
    fetchPrices: async () => {
      const answer = answers[reads++]
      if (answer instanceof Error) throw answer
      return answer ?? null
    },
    now: () => clock,
  })
  source.current()
  await settle()

  for (const expected of [1, 1, 4]) {
    clock += expected === 1 && reads === 1 ? 10 * 60_000 : 60_000
    source.current()
    await settle()
    assert.equal(source.current()?.get('example-model')?.input, expected)
  }
  assert.equal(reads, 4)
})

test('one refresh runs at a time', async () => {
  let reads = 0
  const source = createReferencePriceSource({ fetchPrices: async () => priceList(++reads), now: () => 0 })
  source.current()
  source.current()
  await settle()
  assert.equal(reads, 1)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { ResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { collectorForPass } from './start.js'

const reader = {} as ResponseAuthReader

test('a pass collects through the buyer when it is up', async () => {
  const collector = await collectorForPass({ responseAuth: reader, loadBuyerUrl: async () => 'http://127.0.0.1:8377', log: () => {} })
  assert.equal(collector?.buyerUrl, 'http://127.0.0.1:8377')
  assert.equal(collector?.responseAuth, reader)
})

test('a buyer outage only skips collection, so the pass can still attest and claim', async () => {
  const logs: string[] = []
  const collector = await collectorForPass({
    responseAuth: reader,
    loadBuyerUrl: async () => { throw new Error('buyer is not running') },
    log: (message) => logs.push(message),
  })
  assert.equal(collector, null)
  assert.ok(logs.some((line) => line.includes('buyer is not running')))
})

test('an attest-only verifier never touches the buyer', async () => {
  let loaded = false
  const collector = await collectorForPass({ responseAuth: null, loadBuyerUrl: async () => { loaded = true; return '' }, log: () => {} })
  assert.equal(collector, null)
  assert.equal(loaded, false)
})

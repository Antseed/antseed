import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chatErrorText, freeTierChatError } from './free-tier-error.js'

const limit = {
  peerId: 'abc123', limitedBy: 'address', limit: 1000, windowMs: 86_400_000, retryAfterSeconds: 60,
  stakeTiers: [{ minPower: 520_000, multiplier: 5 }], stakePower: 0,
}
const apiError = (body: unknown) => Object.assign(new Error('429'), { responseBody: JSON.stringify(body) })

test('freeTierChatError finds the buyer free-tier 429 behind retries', () => {
  const last = apiError({ error: { code: 'free_tier_exhausted', message: 'Free limit reached on this seller.' }, free_tier: limit })
  const retried = Object.assign(new Error('Failed after 3 attempts'), { errors: [apiError({ error: { code: 'other' } }), last] })
  const found = freeTierChatError(retried)
  assert.equal(found?.message, 'Free limit reached on this seller.')
  assert.equal(found?.freeTier.peerId, 'abc123')
  assert.deepEqual(JSON.parse(chatErrorText(retried)), found)
})

test('chatErrorText keeps other errors as their message', () => {
  assert.equal(chatErrorText(apiError({ error: { code: 'model_not_found', message: 'nope' } })), '429')
  assert.equal(chatErrorText('boom'), 'boom')
})

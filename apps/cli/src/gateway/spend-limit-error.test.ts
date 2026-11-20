import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spendLimitError } from './server.js'

test('a spent-out limit says it was reached', () => {
  const error = spendLimitError({ period: 'weekly', limitUsdc: 50_000_000, spentUsdc: 50_112_000, heldUsdc: 0, resetsAt: null, level: 'workspace' })
  assert.equal(error.message, "This API key's workspace reached its weekly spend limit of $50.00.")
  assert.equal(error.limit.remaining_usd, '0.000000')
})

test('a limit refused before it is spent says what is left and why', () => {
  // $0.01 lifetime cap, $0.0002 spent, a finished request still holding $0.30 until it is charged.
  const error = spendLimitError({ period: 'total', limitUsdc: 10_000, spentUsdc: 200, heldUsdc: 300_000, resetsAt: null })
  assert.match(error.message, /^This API key has \$0\.0098 left of its lifetime spend limit of \$0\.01 \(\$0\.0002 spent\)/)
  assert.match(error.message, /may use up to \$0\.30 of it/)
  assert.match(error.message, /could cost more than what is left/)
  assert.doesNotMatch(error.message, /reached/)
  assert.equal(error.limit.remaining_usd, '0.009800')
  assert.equal(error.limit.held_usd, '0.300000')
})

test('a limit held by a video job says so, with the hold broken down', () => {
  // $5 daily cap, $0.25 spent, a video job whose price is not charged yet holding $4.999769.
  const error = spendLimitError({ period: 'daily', limitUsdc: 5_000_000, spentUsdc: 252_653, heldUsdc: 4_999_769, heldRequestsUsdc: 0, heldVideoUsdc: 4_999_769, resetsAt: null })
  assert.equal(error.limit.held_usd, '4.999769')
  assert.equal(error.limit.held_requests_usd, '0.000000')
  assert.equal(error.limit.held_video_usd, '4.999769')
  assert.match(error.message, /may use up to \$5\.00 of it \(\$5\.00 for video jobs not yet charged\)/)
})

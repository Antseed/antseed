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

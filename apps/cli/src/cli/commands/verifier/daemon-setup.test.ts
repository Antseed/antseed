import assert from 'node:assert/strict'
import test from 'node:test'
import { MIN_POLL_SECONDS, parsePollInterval } from './daemon-setup.js'

test('--interval must be a finite number of seconds within the timer range', () => {
  assert.equal(parsePollInterval(undefined), 60_000)
  assert.equal(parsePollInterval('90'), 90_000)
  assert.equal(parsePollInterval('2'), MIN_POLL_SECONDS * 1_000, 'raised to the minimum')
  for (const bad of ['60s', '', ' ', 'Infinity', 'NaN', '1e10']) {
    assert.throws(() => parsePollInterval(bad), /--interval must be a number of seconds/, bad)
  }
})

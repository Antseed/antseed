import assert from 'node:assert/strict'
import test from 'node:test'
import { utcDayAuditEpochWindow } from './audit-epoch.js'

test('UTC-day audit epochs use stable daily boundaries', () => {
  assert.deepEqual(utcDayAuditEpochWindow(Date.parse('2026-08-06T17:42:15.000Z')), {
    epoch: '2026-08-06',
    startedAt: Date.parse('2026-08-06T00:00:00.000Z') / 1_000,
    endsAt: Date.parse('2026-08-07T00:00:00.000Z') / 1_000,
    source: 'utc-day',
  })
})

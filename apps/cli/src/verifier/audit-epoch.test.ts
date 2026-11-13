import assert from 'node:assert/strict'
import test from 'node:test'
import { onchainAuditEpochWindow, resolveAuditEpochWindow, utcDayAuditEpochWindow } from './audit-epoch.js'

test('UTC-day audit epochs use stable daily boundaries', () => {
  assert.deepEqual(utcDayAuditEpochWindow(Date.parse('2026-08-06T17:42:15.000Z')), {
    epoch: '2026-08-06',
    startedAt: Date.parse('2026-08-06T00:00:00.000Z') / 1_000,
    endsAt: Date.parse('2026-08-07T00:00:00.000Z') / 1_000,
    source: 'utc-day',
  })
})

test('on-chain audit epochs follow the emissions gate schedule', async () => {
  const window = await onchainAuditEpochWindow({
    currentEpoch: async () => 3,
    genesis: async () => 1_000,
    epochDuration: async () => 604_800,
  })
  assert.deepEqual(window, { epoch: '3', startedAt: 1_000 + 3 * 604_800, endsAt: 1_000 + 4 * 604_800, source: 'onchain' })
})

test('audit epoch prefers the on-chain epoch', async () => {
  const resolved = await resolveAuditEpochWindow(() => ({
    currentEpoch: async () => 5,
    genesis: async () => 0,
    epochDuration: async () => 100,
  }))
  assert.deepEqual(resolved, { window: { epoch: '5', startedAt: 500, endsAt: 600, source: 'onchain' }, warning: null })
})

test('audit epoch falls back to the UTC day with a warning when the chain fails or hangs', async () => {
  const nowMs = Date.parse('2026-10-12T10:00:00.000Z')
  const failed = await resolveAuditEpochWindow(() => { throw new Error('no emissions gate') }, { nowMs })
  assert.equal(failed.window.epoch, '2026-10-12')
  assert.equal(failed.window.source, 'utc-day')
  assert.match(failed.warning ?? '', /no emissions gate.*cannot be submitted on-chain/)
  const never = new Promise<number>(() => undefined)
  const hung = await resolveAuditEpochWindow(() => ({
    currentEpoch: () => never, genesis: () => never, epochDuration: () => never,
  }), { nowMs, timeoutMs: 10 })
  assert.equal(hung.window.source, 'utc-day')
  assert.match(hung.warning ?? '', /timed out/)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import type { AuditorSetEvent } from '@antseed/node/payments'
import type { AuditEpochWindow } from '../../../verifier/audit-epoch.js'
import { epochAuditors, shiftEpochWindow } from './assignment.js'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

function event(auditor: string, approved: boolean, blockNumber: number, timestamp: number): AuditorSetEvent {
  return { auditor, approved, blockNumber, logIndex: 0, timestamp, transactionHash: `0x${blockNumber.toString(16)}` }
}

const current: AuditEpochWindow = { epoch: '29', startedAt: 10_000, endsAt: 11_000, source: 'onchain' }

test('an auditor approved during the current epoch is previewed in the next epoch, not shown in this one', () => {
  const events = [event(A, true, 10, 10_500), event(B, true, 11, 10_600)]
  assert.deepEqual(epochAuditors(events, current, current), { auditors: [], preview: false })
  const next = shiftEpochWindow(current, 30n)
  assert.deepEqual(next, { epoch: '30', startedAt: 11_000, endsAt: 12_000, source: 'onchain' })
  assert.deepEqual(epochAuditors(events, next, current), { auditors: [A, B], preview: true })
  assert.deepEqual(epochAuditors(events, shiftEpochWindow(current, 33n), current), { auditors: [A, B], preview: true })
})

test('an auditor removed during the current epoch is in this epoch and gone from the next', () => {
  const events = [event(A, true, 1, 100), event(B, true, 2, 200), event(B, false, 12, 10_700)]
  assert.deepEqual(epochAuditors(events, current, current).auditors, [A, B])
  assert.deepEqual(epochAuditors(events, shiftEpochWindow(current, 30n), current).auditors, [A])
})

test('a past epoch shows the auditors approved when it started', () => {
  const events = [event(A, true, 1, 100), event(B, true, 2, 9_500)]
  assert.deepEqual(epochAuditors(events, shiftEpochWindow(current, 28n), current), { auditors: [A], preview: false })
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delegationsForBuyer, formatPoolStake, withoutDelegation } from './free-tier.js'

const BUYER = `0x${'11'.repeat(20)}`
const OTHER_BUYER = `0x${'22'.repeat(20)}`
const STAKER = `0x${'aa'.repeat(20)}`
const SIGNATURE = `0x${'00'.repeat(65)}`
const NOW_MS = 1_800_000_000_000

const delegations = [
  { staker: STAKER, buyer: BUYER, expiresAt: NOW_MS / 1000 + 60, signature: SIGNATURE },
  { staker: `0x${'bb'.repeat(20)}`, buyer: BUYER, expiresAt: NOW_MS / 1000 - 60, signature: SIGNATURE },
  { staker: STAKER, buyer: OTHER_BUYER, expiresAt: NOW_MS / 1000 + 60, signature: SIGNATURE },
]

test('lists only this buyer’s delegations and flags expired ones', () => {
  const listed = delegationsForBuyer(delegations, BUYER.toUpperCase().replace('0X', '0x'), NOW_MS)
  assert.deepEqual(listed.map((entry) => [entry.staker, entry.expired]), [[STAKER, false], [`0x${'bb'.repeat(20)}`, true]])
})

test('removes one staker from one buyer only', () => {
  const next = withoutDelegation(delegations, BUYER, STAKER.toUpperCase().replace('0X', '0x'))
  assert.equal(next.length, 2)
  assert.ok(next.some((entry) => entry.buyer === OTHER_BUYER && entry.staker === STAKER))
})

test('describes each pool’s counted stake and how it shrinks', () => {
  const view = { currentEpoch: 10, genesis: Date.UTC(2027, 0, 1) / 1000 - 10 * 604_800, epochDuration: 604_800, pools: [] }
  // An hour into epoch 10.
  const now = Date.UTC(2027, 0, 1, 1) / 1000
  const position = { id: 1, staker: STAKER, startEpoch: 0, closedAtEpoch: null, expiresAt: null }
  const shrinking = { agentId: 7, positions: [{ ...position, ants: 5200, endEpoch: 62, maxLocked: false, maxLockedNext: false }] }
  assert.equal(formatPoolStake(view, shrinking, now), 'pool #7  counts as 5,200 ANTS for a year, shrinking weekly until 2027-12-31')
  const locked = { agentId: 3, positions: [{ ...position, ants: 520, endEpoch: 114, maxLocked: true, maxLockedNext: true }] }
  assert.equal(formatPoolStake(view, locked, now), 'pool #3  counts as 1,040 ANTS for a year; max lock keeps it')
  const shared = { agentId: 3, positions: [{ ...position, ants: 520, endEpoch: 114, maxLocked: true, maxLockedNext: true, expiresAt: Date.UTC(2027, 5, 1) / 1000 }] }
  assert.equal(formatPoolStake(view, shared, now), 'pool #3  counts as 1,040 ANTS for a year; max lock keeps it until the code expires on 2027-06-01')
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { delegationsForBuyer, withoutDelegation } from './free-tier.js'

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

import assert from 'node:assert/strict'
import test from 'node:test'
import { VERIFICATION_REWARDS_OFF } from '@antseed/node/payments'
import { describeRewardSettings, parseEpochList } from './rewards.js'

test('parses epoch lists and ranges into sorted unique epochs', () => {
  assert.deepEqual(parseEpochList('4, 2-3,2'), [2n, 3n, 4n])
  assert.throws(() => parseEpochList('3-1'), /invalid epoch range/)
  assert.throws(() => parseEpochList('x'), /invalid epoch/)
  assert.throws(() => parseEpochList(' , '), /at least one epoch/)
})

test('describes whether KBF rewards are on, the share and the cap', () => {
  assert.match(
    describeRewardSettings({ rewardsStartEpoch: VERIFICATION_REWARDS_OFF, shareBps: 10_000, maxAuditorShareBps: 2_000 }),
    /rewards are off.*100% of the verification bucket.*at most 20% of it per auditor/,
  )
  assert.match(
    describeRewardSettings({ rewardsStartEpoch: 30n, shareBps: 6_000, maxAuditorShareBps: 2_000 }),
    /from epoch 30; KBF share 60%/,
  )
})

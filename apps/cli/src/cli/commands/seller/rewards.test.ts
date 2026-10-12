import assert from 'node:assert/strict';
import test from 'node:test';
import { totalSellerRewards } from './rewards.js';
import { RewardClaimProgress } from '../reward-actions.js';

test('totalSellerRewards combines legacy, usage, and pool rewards', () => {
  assert.equal(totalSellerRewards({ legacy: 1n, usage: 2n, pool: 3n, poolPositions: [] }), 6n);
});

test('confirmed transactions remain visible if a later claim or receipt read fails', async () => {
  const shown: string[] = [];
  const progress = new RewardClaimProgress((hash) => shown.push(hash), async (hash) => {
    if (hash === 'receipt-failure') throw new Error('RPC timeout');
    return 10n;
  });
  await progress.record('legacy-confirmed', 'claim');
  await assert.rejects(progress.record('receipt-failure', 'claim'), /RPC timeout/);
  assert.deepEqual(shown, ['legacy-confirmed', 'receipt-failure']);
  assert.equal(progress.claimed, 10n);
  assert.match(progress.failure('usage claim failed'), /2 transaction\(s\) already confirmed/);
});

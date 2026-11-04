import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { REWARDS_ERROR_FRESH_MS, REWARDS_FRESH_MS, cachedRead, clearChainReads, disposeChainReads, readKeys } from '../payments/read-cache.js';
import { EMPTY_REWARDS_SUMMARY, rewardsErrorSummary } from './buyer-rewards.js';

// gcTime timers would keep the test process alive.
after(() => disposeChainReads());

const BUSY = 'The network is busy right now. Try again in a minute.';

test('a rejected rewards read is cached as an empty summary with a friendly error', async () => {
  clearChainReads();
  // As the rewards-summary IPC handler reads: a failed read becomes a summary, not a rejection.
  const data = await cachedRead(
    readKeys.rewards('0x00000000000000000000000000000000000000AA', 'base-mainnet'),
    (cached) => (cached?.error ? REWARDS_ERROR_FRESH_MS : REWARDS_FRESH_MS),
    () => Promise.reject(new Error('Every RPC endpoint is rate limiting requests')).catch(rewardsErrorSummary),
  );
  assert.deepEqual(data, { ...EMPTY_REWARDS_SUMMARY, error: BUSY });
});

test('rewardsErrorSummary keeps errors that are not network trouble', () => {
  assert.deepEqual(rewardsErrorSummary(new Error('Rewards contract not configured')), { ...EMPTY_REWARDS_SUMMARY, error: 'Rewards contract not configured' });
  assert.equal(rewardsErrorSummary('HTTP 429 Too Many Requests').error, BUSY);
});

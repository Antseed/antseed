import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import type { AntsChainConfig } from '@antseed/ants/service';
import { clearChainReads, disposeChainReads } from './read-cache.js';
import { EMPTY_REWARDS_SUMMARY, cachedBuyerRewardsSummary } from './rewards-summary.js';

after(() => disposeChainReads());

const chain = { chainId: 'base-mainnet' } as AntsChainConfig;

test('a timed-out or rate-limited rewards read returns the retry hint, not the raw RPC error', async () => {
  for (const [wallet, raw] of [
    ['0x1111111111111111111111111111111111111111', 'request timeout (code=TIMEOUT, version=6.13.0)'],
    ['0x2222222222222222222222222222222222222222', 'server response 429 Too Many Requests'],
  ] as const) {
    clearChainReads();
    const data = await cachedBuyerRewardsSummary(chain, wallet, async () => { throw new Error(raw); });
    assert.deepEqual(data, { ...EMPTY_REWARDS_SUMMARY, error: 'The network is busy right now. Try again in a minute.' });
  }
});

test('other rewards read failures keep their message, and a success is cached per wallet', async () => {
  clearChainReads();
  const wallet = '0x3333333333333333333333333333333333333333';
  const failed = await cachedBuyerRewardsSummary(chain, wallet, async () => { throw new Error('emissions contract missing'); });
  assert.equal(failed.error, 'emissions contract missing');

  clearChainReads();
  let calls = 0;
  const summary = { available: true, pendingAnts: '1.5', currentEpoch: 3, transfersEnabled: false, error: null };
  const read = async () => { calls++; return summary; };
  assert.deepEqual(await cachedBuyerRewardsSummary(chain, wallet, read), summary);
  assert.deepEqual(await cachedBuyerRewardsSummary(chain, wallet, read), summary);
  assert.equal(calls, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { unreadRewardsSummary } from './rewards.js';

test('a gateway without a rewards route gets no amount read on this app\'s chain', () => {
  const summary = unreadRewardsSummary('0xabc');
  assert.equal(summary.available, false);
  assert.equal(summary.remoteChainUnverified, true);
  assert.equal(summary.address, '0xabc');
});

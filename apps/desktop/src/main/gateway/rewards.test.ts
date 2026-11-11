import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remoteRewardsSummary } from './rewards.js';

test('a remote gateway\'s rewards carry no amount read on this app\'s chain', () => {
  const summary = remoteRewardsSummary('0xabc');
  assert.equal(summary.available, false);
  assert.equal(summary.remoteChainUnverified, true);
  assert.equal(summary.address, '0xabc');
});

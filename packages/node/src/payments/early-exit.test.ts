import assert from 'node:assert/strict';
import { test } from 'vitest';
import { estimateEarlyExit } from './evm/seller-pools-client.js';

const position = { id: 1, owner: '0x1', agentId: 2, amount: 1n, weightAmount: 1n, stakeStartEpoch: 5, stakeEndEpoch: 9, closedAtEpoch: 0, withdrawn: false };
test('estimateEarlyExit reports exact principal loss and return', () => {
  assert.deepEqual(estimateEarlyExit({ ...position, amount: 100n * 10n ** 18n }, 2500), {
    id: 1,
    amount: 100n * 10n ** 18n,
    slashBps: 2500,
    slashedAmount: 25n * 10n ** 18n,
    returnedAmount: 75n * 10n ** 18n,
  });
});

import assert from 'node:assert/strict';
import { test } from 'vitest';
import { estimateEarlyExit, projectedEarlyExitSlashBps } from './evm/seller-pools-client.js';

const position = { id: 1, owner: '0x1', agentId: 2, amount: 1n, weightAmount: 1n, stakeStartEpoch: 5, stakeEndEpoch: 9, closedAtEpoch: 0, withdrawn: false };
const slashConfig = { maxSlashBps: 5_000, minEarlyExitSlashBps: 500 };

test('projectedEarlyExitSlashBps divides by the normal lock window when the normal start is given', () => {
  // Merged at 30 from positions staked at 10, ends 114: the pool's window is 10 -> 114, not 30 -> 114.
  const merged = { stakeStartEpoch: 30, stakeEndEpoch: 114 };
  assert.equal(projectedEarlyExitSlashBps(merged, 40, slashConfig), Math.floor(5_000 * 74 / 84));
  assert.equal(projectedEarlyExitSlashBps(merged, 40, slashConfig, false, 10), Math.floor(5_000 * 74 / 104));
  // The close epoch still clamps to the public start: before it, the whole remaining window counts.
  assert.equal(projectedEarlyExitSlashBps(merged, 20, slashConfig, false, 10), Math.floor(5_000 * 84 / 104));
  // The pool's clamps, its max-lock rule, and a normal start of 0 (kept while max locked) giving 0.
  assert.equal(projectedEarlyExitSlashBps(merged, 113, slashConfig, false, 10), 500);
  assert.equal(projectedEarlyExitSlashBps(merged, 114, slashConfig, false, 10), 0);
  assert.equal(projectedEarlyExitSlashBps(merged, 40, slashConfig, true, 10), 5_000);
  assert.equal(projectedEarlyExitSlashBps(merged, 40, slashConfig, false, 0), 0);
});
test('estimateEarlyExit reports exact principal loss and return', () => {
  assert.deepEqual(estimateEarlyExit({ ...position, amount: 100n * 10n ** 18n }, 2500), {
    id: 1,
    amount: 100n * 10n ** 18n,
    slashBps: 2500,
    slashedAmount: 25n * 10n ** 18n,
    returnedAmount: 75n * 10n ** 18n,
  });
});

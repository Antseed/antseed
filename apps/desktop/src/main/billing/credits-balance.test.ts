import test from 'node:test';
import assert from 'node:assert/strict';

import {
  spendableBalance,
  totalOwnedBalance,
} from './credits-balance.js';

test('spendable is the deposit less what has been authorized away', () => {
  // $10 deposited, $5 reserved into a channel, $0.30 signed for so far.
  assert.equal(spendableBalance(10_000_000n, 300_000n), 9_700_000n);
  // Reserving alone must not move it.
  assert.equal(spendableBalance(10_000_000n, 0n), 10_000_000n);
});

test('spendable clamps at zero when pending briefly outruns the on-chain total', () => {
  assert.equal(spendableBalance(1_000n, 5_000n), 0n);
  assert.equal(spendableBalance(0n, 0n), 0n);
});

test('total owned includes USDC waiting in the buyer wallet', () => {
  assert.equal(totalOwnedBalance(39_110_000n, 10_000_000n), 49_110_000n);
  assert.equal(totalOwnedBalance(39_110_000n, 0n), 39_110_000n);
});

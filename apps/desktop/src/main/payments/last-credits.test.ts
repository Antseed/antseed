import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayCreditsInfo } from './gateway-credits.js';
import { LastCredits } from './last-credits.js';

const known = gatewayCreditsInfo({
  label: 'Desktop', buyerAddress: '0x00000000000000000000000000000000000000aa', requests: 0, spentUsd: '0', limits: {}, createdAt: null,
  balance: { availableUsd: '5.000000', reservedUsd: '0', pendingUsd: '0', walletUsd: '0', creditLimitUsd: '0', operator: null, stale: false },
});
const failed = gatewayCreditsInfo(null);

test('a failed read keeps showing the last known balance', () => {
  const last = new LastCredits();
  last.settle(known, 'local a');
  assert.equal(last.settle(failed, 'local a'), known);
  assert.equal(last.isZero(), false);
});

test('after the identity changes, a failed read never shows the previous signer\'s balance', () => {
  const last = new LastCredits();
  last.settle(known, 'local a');
  last.clear();
  assert.equal(last.settle(failed, 'local a').balanceKnown, false);
  assert.equal(last.isZero(), undefined);
});

test('a failed read on another gateway or key never shows the previous one\'s balance', () => {
  const last = new LastCredits();
  last.settle(known, 'local a');
  const switched = last.settle(failed, 'remote b');
  assert.equal(switched.balanceKnown, false);
  assert.equal(switched.evmAddress, null);
  assert.equal(last.isZero(), undefined);
  // Back on the first gateway, the old answer is gone too: it may have changed meanwhile.
  assert.equal(last.settle(failed, 'local a').balanceKnown, false);
});

test('no gateway answering serves no cached balance', () => {
  const last = new LastCredits();
  last.settle(known, 'local a');
  assert.equal(last.settle(failed, null).balanceKnown, false);
});

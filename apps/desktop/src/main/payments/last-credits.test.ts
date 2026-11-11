import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayCreditsInfo } from './gateway-credits.js';
import { LastCredits } from './last-credits.js';

const known = gatewayCreditsInfo({
  label: 'Desktop', buyerAddress: '0x00000000000000000000000000000000000000aa', requests: 0, spentUsd: '0', limits: {},
  balance: { availableUsd: '5.000000', reservedUsd: '0', pendingUsd: '0', walletUsd: '0', creditLimitUsd: '0', operator: null, stale: false },
});
const failed = gatewayCreditsInfo(null);

test('a failed read keeps showing the last known balance', () => {
  const last = new LastCredits();
  last.settle(known);
  assert.equal(last.settle(failed), known);
  assert.equal(last.isZero(), false);
});

test('after the identity changes, a failed read never shows the previous signer\'s balance', () => {
  const last = new LastCredits();
  last.settle(known);
  last.clear();
  assert.equal(last.settle(failed).balanceKnown, false);
  assert.equal(last.isZero(), undefined);
});

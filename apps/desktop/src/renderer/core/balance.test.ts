import assert from 'node:assert/strict';
import { test } from 'vitest';
import { selectHeadlineBalanceUsdc } from './balance';

test('headline balance includes USDC awaiting deposit sweep', () => {
  const state = {
    creditsSpendableUsdc: '49.91',
    creditsTotalOwnedUsdc: '153.78',
  };

  assert.equal(selectHeadlineBalanceUsdc(state), '153.78');
});

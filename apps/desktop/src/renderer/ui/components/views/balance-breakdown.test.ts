import assert from 'node:assert/strict';
import { test } from 'vitest';
import { hasPositiveAmount, isEntireBalanceLocked, walletBalanceMessage } from './balance-breakdown';

const values = {
  available: '39',
  reserved: '1',
  pending: '0',
  wallet: '10',
  totalOwned: '50',
  creditLimit: '40',
  deposited: '40',
};

test('positive amount detection drives warning visibility', () => {
  assert.equal(hasPositiveAmount('1'), true);
  assert.equal(hasPositiveAmount('0'), false);
  assert.equal(hasPositiveAmount('not-a-number'), false);
});

test('locked warning only appears when no funds remain outside channels', () => {
  assert.equal(isEntireBalanceLocked({ available: '0', reserved: '2.69', wallet: '0' }), true);
  assert.equal(isEntireBalanceLocked({ available: '15.77', reserved: '2.69', wallet: '0' }), false);
  assert.equal(isEntireBalanceLocked({ available: '0', reserved: '2.69', wallet: '5' }), false);
  assert.equal(isEntireBalanceLocked({ available: '0', reserved: '0', wallet: '0' }), false);
});

test('wallet message explains funds retained above contract headroom', () => {
  assert.match(walletBalanceMessage(values), /account limit/);
  assert.match(walletBalanceMessage({ ...values, deposited: '35', wallet: '10' }), /account limit/);
});

test('wallet message describes an ordinary pending sweep', () => {
  assert.match(walletBalanceMessage({ ...values, deposited: '20', wallet: '10' }), /waiting to be added/);
});

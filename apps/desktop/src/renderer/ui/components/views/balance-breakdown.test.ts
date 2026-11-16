import assert from 'node:assert/strict';
import { test } from 'vitest';
import { balanceSplit, hasPositiveAmount, isEntireBalanceLocked, walletBalanceMessage } from './balance-breakdown';

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

test('what sessions hold links to the gateway\'s channel list whenever there is any, not only when little is available (#1463)', () => {
  // $7.84 available and $4.69 held: no funding blocker, yet the held part must still lead to where it can be closed.
  assert.deepEqual(balanceSplit({ available: '7.84', reserved: '4.69', wallet: '0' }), [
    { label: 'available', value: '7.84', opensSessions: false },
    { label: 'held in sessions', value: '4.69', opensSessions: true },
  ]);
  assert.deepEqual(balanceSplit({ available: '0', reserved: '1', wallet: '2' })?.map((part) => [part.label, part.opensSessions]), [
    ['available', false], ['held in sessions', true], ['not deposited yet', false],
  ]);
  // Nothing held and nothing waiting: the headline says it all.
  assert.equal(balanceSplit({ available: '5', reserved: '0', wallet: '0' }), null);
});

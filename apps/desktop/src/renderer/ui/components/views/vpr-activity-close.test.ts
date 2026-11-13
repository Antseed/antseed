import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  channelCloseAction,
  channelRecoverableBaseUnits,
  compareChannelsByLockedAmount,
  formatChannelLockedAmount,
  isFundedCurrentChannel,
  isCurrentChannelStatus,
  unaccountedReserveLine,
} from './vpr-activity-close';

test('channelRecoverableBaseUnits counts signed-but-unsettled spend as spent', () => {
  // Seller has settled nothing on-chain yet, but the buyer already signed
  // $0.63 away — only $0.37 of the $1.00 reserve is recoverable.
  assert.equal(channelRecoverableBaseUnits({ onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '630000' }), 370_000n);
  // On-chain settled ahead of the local signed record (fresh install) wins.
  assert.equal(channelRecoverableBaseUnits({ onChainDeposit: '1000000', onChainSettled: '800000', cumulativeSigned: '630000' }), 200_000n);
  assert.equal(channelRecoverableBaseUnits({ onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '1000000' }), 0n);
  assert.equal(channelRecoverableBaseUnits({ onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '2000000' }), 0n);
  assert.equal(channelRecoverableBaseUnits({ onChainDeposit: 'invalid', onChainSettled: '0', cumulativeSigned: '0' }), 0n);
});

test('formatChannelLockedAmount shows the recoverable amount, not the raw reserve', () => {
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: false, onChainDeposit: '0', onChainSettled: '0', cumulativeSigned: '0' }), 'Locked amount unavailable');
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '619815', onChainSettled: '619815', cumulativeSigned: '0' }), 'No funds locked');
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '9000', onChainSettled: '0', cumulativeSigned: '0' }), '<$0.01 locked');
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '700000', cumulativeSigned: '0' }), '$4.30 locked');
  // Signed-but-unsettled spend reduces what shows as locked.
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '630000' }), '$0.37 locked');
});

test('formatChannelLockedAmount names what a fully signed channel still holds on-chain', () => {
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '1000000' }), '$1.00 unsettled');
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '1000000', onChainSettled: '250000', cumulativeSigned: '2000000' }), '$0.75 unsettled');
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '1000000', onChainSettled: '995000', cumulativeSigned: '1000000' }), '<$0.01 unsettled');
});

test('compareChannelsByLockedAmount sorts highest recoverable amount first', () => {
  const channels = [
    { onChainDeposit: '2000000', onChainSettled: '0', cumulativeSigned: '0', reservedAt: 3 },
    { onChainDeposit: '5000000', onChainSettled: '700000', cumulativeSigned: '0', reservedAt: 1 },
    { onChainDeposit: '2000000', onChainSettled: '0', cumulativeSigned: '0', reservedAt: 5 },
    // Reserve is high but almost fully signed away — sorts last.
    { onChainDeposit: '5000000', onChainSettled: '0', cumulativeSigned: '4900000', reservedAt: 9 },
  ].sort(compareChannelsByLockedAmount);

  assert.deepEqual(channels.map((channel) => channel.reservedAt), [1, 5, 3, 9]);
});

test('channelCloseAction exposes seller close only for supported active channels', () => {
  assert.equal(channelCloseAction('active', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('open', true), 'seller-and-on-chain');
  assert.equal(channelCloseAction('active', false), 'on-chain');
  assert.equal(channelCloseAction('active', true, true), 'on-chain');
  assert.equal(channelCloseAction('closing', true), 'none');
  assert.equal(channelCloseAction('withdrawable', true), 'withdraw');
});

test('isCurrentChannelStatus keeps only channels that still hold funds', () => {
  for (const status of ['active', 'open', 'closing', 'withdrawable']) {
    assert.equal(isCurrentChannelStatus(status), true);
  }
  for (const status of ['settled', 'timedout', 'timeout', 'closed', 'unknown']) {
    assert.equal(isCurrentChannelStatus(status), false);
  }
});

test('isFundedCurrentChannel hides channels only after confirming the chain holds nothing', () => {
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: false, onChainDeposit: '0', onChainSettled: '0', cumulativeSigned: '0' }), true);
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '700000', cumulativeSigned: '0' }), true);
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '5000000', cumulativeSigned: '0' }), false);
  assert.equal(isFundedCurrentChannel({ status: 'settled', onChainStateKnown: false, onChainDeposit: '5000000', onChainSettled: '0', cumulativeSigned: '0' }), false);
});

test('isFundedCurrentChannel lists a channel the buyer signed in full while the chain still holds it', () => {
  // If the seller never settles, withdraw() returns all of it, so it must stay reachable.
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '0', cumulativeSigned: '5000000' }), true);
});

test('unaccountedReserveLine names an on-chain reserve no listed channel accounts for', () => {
  assert.equal(unaccountedReserveLine('2250000'), '$2.25 is held by a session this app has no record of.');
  assert.equal(unaccountedReserveLine('5000'), '<$0.01 is held by a session this app has no record of.');
  // Nothing unaccounted, not judged by the buyer, or a buyer that predates the figure: no line.
  assert.equal(unaccountedReserveLine('0'), null);
  assert.equal(unaccountedReserveLine(null), null);
  assert.equal(unaccountedReserveLine(undefined), null);
  assert.equal(unaccountedReserveLine('not a number'), null);
});

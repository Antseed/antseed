import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
  channelCloseAction,
  channelRecoverableBaseUnits,
  compareChannelsByLockedAmount,
  formatChannelLockedAmount,
  isFundedCurrentChannel,
  isCurrentChannelStatus,
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
  assert.equal(formatChannelLockedAmount({ onChainStateKnown: true, onChainDeposit: '1000000', onChainSettled: '0', cumulativeSigned: '1000000' }), 'No funds locked');
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

test('isFundedCurrentChannel hides channels only after confirming nothing is recoverable', () => {
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: false, onChainDeposit: '0', onChainSettled: '0', cumulativeSigned: '0' }), true);
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '700000', cumulativeSigned: '0' }), true);
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '5000000', cumulativeSigned: '0' }), false);
  // Fully spent via signed-but-unsettled auths — nothing recoverable, hide it.
  assert.equal(isFundedCurrentChannel({ status: 'active', onChainStateKnown: true, onChainDeposit: '5000000', onChainSettled: '0', cumulativeSigned: '5000000' }), false);
  assert.equal(isFundedCurrentChannel({ status: 'settled', onChainStateKnown: false, onChainDeposit: '5000000', onChainSettled: '0', cumulativeSigned: '0' }), false);
});


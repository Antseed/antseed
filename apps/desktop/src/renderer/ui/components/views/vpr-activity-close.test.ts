import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { DesktopBridge } from '../../../types/bridge';
import {
  channelCloseAction,
  channelRecoverableBaseUnits,
  compareChannelsByLockedAmount,
  cooperativeCloseRejectionMessage,
  formatChannelLockedAmount,
  isFundedCurrentChannel,
  isCurrentChannelStatus,
  requestSellerAssistedClose,
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

test('cooperativeCloseRejectionMessage maps actionable rejection codes', () => {
  const base = { version: 1 as const, channelId: 'channel-1', status: 'rejected' as const };
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'busy' }), /processing a request/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'pending_auth' }), /payment authorization/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'no_channel' }), /refresh Activity/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'invalid_auth' }), /on-chain close/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'close_failed' }), /on-chain close/i);
  assert.match(cooperativeCloseRejectionMessage({ ...base, code: 'unsupported' }), /does not support/i);
});

test('requestSellerAssistedClose refreshes balances and channels after success', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'success');
  assert.equal(credits.mock.calls.length, 1);
  assert.equal(summary.mock.calls.length, 1);
});

test('requestSellerAssistedClose preserves success when refreshes fail', async () => {
  const credits = vi.fn(async () => { throw new Error('credits unavailable'); });
  const summary = vi.fn(async () => { throw new Error('summary unavailable'); });
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'closed' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'success');
  assert.equal(feedback.message, 'Seller closed the channel.');
  assert.equal(credits.mock.calls.length, 1);
  assert.equal(summary.mock.calls.length, 1);
});

test('requestSellerAssistedClose keeps rejection local and does not refresh', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: true,
      result: { version: 1, channelId: 'channel-1', status: 'rejected', code: 'busy' },
      error: null,
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.equal(feedback.tone, 'error');
  assert.equal(credits.mock.calls.length, 0);
  assert.equal(summary.mock.calls.length, 0);
});

test('requestSellerAssistedClose reports transport failures without refreshing', async () => {
  const credits = vi.fn(async () => {});
  const summary = vi.fn(async () => {});
  const bridge: DesktopBridge = {
    paymentsRequestCooperativeClose: vi.fn(async () => ({
      ok: false,
      result: null,
      error: 'Seller is offline.',
    })),
  };

  const feedback = await requestSellerAssistedClose('peer-1', bridge, { credits, summary });

  assert.match(feedback.message, /channel is unchanged/i);
  assert.equal(credits.mock.calls.length, 0);
  assert.equal(summary.mock.calls.length, 0);
});

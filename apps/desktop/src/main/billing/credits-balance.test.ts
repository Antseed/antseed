import test from 'node:test';
import assert from 'node:assert/strict';

import {
  creditsBalanceTotals,
  isOpenChannelStatus,
  pendingSpendFromChannels,
  spendableBalance,
  totalOwnedBalance,
  unsettledSpend,
  updateCreditsBalanceComponents,
} from './credits-balance.js';

test('unsettledSpend is what the seller can still claim on a channel', () => {
  assert.equal(unsettledSpend({ status: 'active', cumulativeSigned: '50000', onChainSettled: '20000' }), 30000n);
  // Fully settled: nothing outstanding.
  assert.equal(unsettledSpend({ status: 'active', cumulativeSigned: '50000', onChainSettled: '50000' }), 0n);
  // A settle that raced ahead of the local store must not go negative.
  assert.equal(unsettledSpend({ status: 'active', cumulativeSigned: '50000', onChainSettled: '60000' }), 0n);
});

test('unsettledSpend counts no more than the deposit once no top-up can raise it', () => {
  const now = 2_000_000_000;
  // Signed past the reserve (a top-up that never landed), on a channel the chain was read for.
  const signedPast = { status: 'active', cumulativeSigned: '2000000', onChainSettled: '250000', onChainStateKnown: true, onChainDeposit: '1000000' };
  // The top-up's ReserveAuth has expired: the seller can settle the deposit at most.
  assert.equal(unsettledSpend({ ...signedPast, deadline: now - 2 * 3600 }, now), 750000n);
  // A close was requested, which stops every top-up whatever its deadline.
  assert.equal(unsettledSpend({ ...signedPast, status: 'closing', deadline: now + 3600 }, now), 750000n);
  assert.equal(unsettledSpend({ ...signedPast, status: 'withdrawable', deadline: now + 3600 }, now), 750000n);
  // The ReserveAuth can still land and lift the deposit, or its deadline is unknown: all of it counts.
  assert.equal(unsettledSpend({ ...signedPast, deadline: now + 3600 }, now), 1750000n);
  assert.equal(unsettledSpend({ ...signedPast, deadline: 0 }, now), 1750000n);
  // Before the chain is read the deposit is unknown, so all of it counts.
  assert.equal(unsettledSpend({ ...signedPast, onChainStateKnown: false, deadline: now - 2 * 3600 }, now), 1750000n);
});

test('unsettledSpend treats missing and malformed amounts as zero', () => {
  assert.equal(unsettledSpend({ status: 'active', cumulativeSigned: '', onChainSettled: '' }), 0n);
  assert.equal(unsettledSpend({ status: 'active', cumulativeSigned: 'nope', onChainSettled: '0' }), 0n);
});

test('pending counts every status the seller can still settle against', () => {
  for (const status of ['active', 'open', 'pending', 'closing', 'close_requested', 'withdrawable']) {
    assert.equal(isOpenChannelStatus(status), true, status);
    assert.equal(
      pendingSpendFromChannels([{ status, cumulativeSigned: '10000', onChainSettled: '0' }]),
      10000n,
      status,
    );
  }
});

test('pending ignores finished channels — their signatures are spent, not owed', () => {
  for (const status of ['settled', 'timedout', 'timeout', 'ghost', 'unknown']) {
    assert.equal(isOpenChannelStatus(status), false, status);
    assert.equal(
      pendingSpendFromChannels([{ status, cumulativeSigned: '10000', onChainSettled: '0' }]),
      0n,
      status,
    );
  }
});

test('pending sums the open channels and skips the rest', () => {
  const pending = pendingSpendFromChannels([
    { status: 'active', cumulativeSigned: '30000', onChainSettled: '10000' },
    { status: 'closing', cumulativeSigned: '5000', onChainSettled: '0' },
    { status: 'settled', cumulativeSigned: '90000', onChainSettled: '90000' },
    { status: 'active', cumulativeSigned: 'garbage', onChainSettled: '0' },
  ]);
  assert.equal(pending, 25000n);
  assert.equal(pendingSpendFromChannels([]), 0n);
});

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

test('component updates retain last-known-good values for failed reads', () => {
  const previous = {
    available: 33_000_000n,
    reserved: 10_000_000n,
    pending: 1_000_000n,
    wallet: 59_000_000n,
  };

  const next = updateCreditsBalanceComponents(previous, {
    available: 32_000_000n,
    reserved: 11_000_000n,
  });

  assert.deepEqual(next, {
    available: 32_000_000n,
    reserved: 11_000_000n,
    pending: 1_000_000n,
    wallet: 59_000_000n,
  });
  assert.equal(creditsBalanceTotals(next).totalOwned, 101_000_000n);
});

test('successful zero component reads replace older non-zero values', () => {
  const next = updateCreditsBalanceComponents({
    available: 33_000_000n,
    reserved: 10_000_000n,
    pending: 1_000_000n,
    wallet: 59_000_000n,
  }, {
    pending: 0n,
    wallet: 0n,
  });

  assert.equal(next.pending, 0n);
  assert.equal(next.wallet, 0n);
  assert.equal(creditsBalanceTotals(next).totalOwned, 43_000_000n);
});

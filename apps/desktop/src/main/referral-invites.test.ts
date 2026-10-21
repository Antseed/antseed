import assert from 'node:assert/strict';
import test from 'node:test';
import type { ReferralView, ReferredBuyersView } from '@antseed/ants/service';
import { combineInviteReads } from './referral-invites.js';

const allowance = { epoch: 31, quota: 3, used: 3, left: 0 };
const card: ReferralView = { available: true, indexed: false, payable: '0', claimableEpochs: [], referredCount: 2, invites: allowance };
const ok = <T>(value: T): PromiseSettledResult<T> => ({ status: 'fulfilled', value });
const failed = <T>(reason: unknown): PromiseSettledResult<T> => ({ status: 'rejected', reason });

test('a failing referred-buyer list keeps the allowance the contract reported', () => {
  const invites = combineInviteReads(ok(card), failed<ReferredBuyersView>(new Error('HTTP 404 Not Found')));
  assert.deepEqual(invites.allowance, allowance);
  assert.equal(invites.available, true);
  assert.deepEqual(invites.buyers, []);
  assert.ok(invites.error);
});

test('an explorer that does not list referrals keeps the allowance without an error', () => {
  const invites = combineInviteReads(ok(card), ok<ReferredBuyersView>({ available: false, buyers: [] }));
  assert.deepEqual(invites, { available: true, listed: false, allowance, buyers: [], totals: { points: '0', ants: '0', pendingPoints: '0' }, error: null });
});

test('a listed explorer sums the referred buyers', () => {
  const buyers = [
    { buyer: '0x2222222222222222222222222222222222222222', boundEpoch: 30, points: '5', ants: '1000000000000000000', pendingPoints: '1' },
    { buyer: '0x3333333333333333333333333333333333333333', boundEpoch: null, points: '7', ants: '500000000000000000', pendingPoints: '0' },
  ];
  const invites = combineInviteReads(ok(card), ok<ReferredBuyersView>({ available: true, buyers }));
  assert.equal(invites.listed, true);
  assert.deepEqual(invites.allowance, allowance);
  assert.deepEqual(invites.totals.points, '12');
  assert.equal(invites.error, null);
});

test('a failing contract read without a listing leaves invites usable with no allowance', () => {
  const invites = combineInviteReads(failed<ReferralView>(new Error('boom')), ok<ReferredBuyersView>({ available: false, buyers: [] }));
  assert.equal(invites.allowance, null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGatewayKeyInfo, parseKeyRewards, parseKeySavings, parseRetiredUsage, parseWalletKeyUsage, sumSavings, withUsageOf } from './key-info.js';

test('key info is read from inside the gateway\'s data envelope', () => {
  assert.deepEqual(parseGatewayKeyInfo({
    data: {
      label: 'Desktop',
      buyer_address: '0xabc',
      usage: { requests: 3, spent_usd: '1.50' },
      limits: { daily: { limit_usd: '5.00', spent_usd: '1.50' } },
      balance: { available_usd: '12.500000', reserved_usd: '0.250000', pending_usd: '0.100000', wallet_usd: null, credit_limit_usd: '50.000000', operator: null, stale: false },
    },
  }), {
    label: 'Desktop',
    buyerAddress: '0xabc',
    requests: 3,
    spentUsd: '1.50',
    limits: { daily: { limitUsd: '5.00', spentUsd: '1.50' } },
    balance: { availableUsd: '12.500000', reservedUsd: '0.250000', pendingUsd: '0.100000', walletUsd: null, creditLimitUsd: '50.000000', operator: null, stale: false },
  });
});

test('a gateway that does not report the balance leaves it unknown', () => {
  assert.equal(parseGatewayKeyInfo({ data: { label: 'Desktop' } })?.balance, null);
  assert.equal(parseGatewayKeyInfo({ data: { label: 'Desktop', balance: { available_usd: 3 } } })?.balance, null);
});

test('an answer without the envelope is no key info', () => {
  assert.equal(parseGatewayKeyInfo({ label: 'Desktop' }), null);
  assert.equal(parseGatewayKeyInfo(null), null);
});

test('usage sums every key on the wallet; limits stay the desktop key\'s', () => {
  const desktop = { label: 'Desktop', buyerAddress: '0xabc', requests: 3, spentUsd: '1.50', limits: { daily: { limitUsd: '5.00', spentUsd: '1.50' } }, balance: null };
  const app = { label: 'Desktop · Codex', buyerAddress: '0xabc', requests: 7, spentUsd: '0.25', limits: {}, balance: null };
  assert.deepEqual(withUsageOf(desktop, [app]), { ...desktop, requests: 10, spentUsd: '1.75' });
  assert.deepEqual(withUsageOf({ ...desktop, spentUsd: null }, []), { ...desktop, spentUsd: null });
});

test('rewards are read from the gateway\'s answer, and none when it could not read them', () => {
  assert.deepEqual(parseKeyRewards({ data: { available: true, address: '0xabc', pending_ants: '3.5', current_epoch: 12, transfers_enabled: true } }), {
    available: true, address: '0xabc', pendingAnts: '3.5', currentEpoch: 12, transfersEnabled: true,
  });
  assert.equal(parseKeyRewards({ data: null }), null);
});

test('savings from several keys add up; none when no key had any', () => {
  const one = parseKeySavings({ data: { retail_usd: 2, paid_usd: 0.5, saved_usd: 1.5, matched_requests: 3 } });
  const two = parseKeySavings({ data: { retail_usd: 1, paid_usd: 0, saved_usd: 1, matched_requests: 1 } });
  assert.deepEqual(sumSavings([one, null, two]), { retailUsd: 3, paidUsd: 0.5, savedUsd: 2.5, matchedRequests: 4 });
  assert.equal(sumSavings([null, parseKeySavings({ data: null })]), null);
});

test('an app that stops using its own key keeps its requests, spend and savings in the totals', () => {
  const desktop = { label: 'Desktop', buyerAddress: '0xabc', requests: 3, spentUsd: '1.50', limits: {}, balance: null };
  const app = { label: 'Desktop · Codex', buyerAddress: '0xabc', requests: 7, spentUsd: '0.25', limits: {}, balance: null };
  const appSavings = { data: { retail_usd: 4, paid_usd: 0.25, saved_usd: 3.75, matched_requests: 7 } };
  const before = { info: withUsageOf(desktop, [app]), savings: sumSavings([parseKeySavings(appSavings)]) };

  // Shared mode revokes the app's key; the owner's read of its id answers instead.
  const retired = parseRetiredUsage({ data: { requests: 7, spent_usd: '0.250000', savings: appSavings.data } });
  assert.ok(retired);
  const after = { info: withUsageOf(desktop, [retired.usage]), savings: sumSavings([retired.savings]) };
  assert.equal(after.info.requests, before.info.requests);
  assert.equal(after.info.spentUsd, before.info.spentUsd);
  assert.deepEqual(after.savings, before.savings);
});

test('retired usage without savings, or an answer that is not one, adds nothing it does not have', () => {
  assert.equal(parseRetiredUsage({ data: { requests: 2, spent_usd: '0.10', savings: null } })?.savings, null);
  assert.equal(parseRetiredUsage(null), null);
  assert.equal(parseRetiredUsage({ error: 'Unknown key' }), null);
});

test('the gateway\'s totals for a wallet cover every key paying from it, revoked ones and failed requests included', () => {
  const keys = [
    { label: 'Desktop', status: 'active', identity: 'default', requests: 120, failedRequests: 20, spentUsd: { total: '4.250000' } },
    { label: 'Desktop', status: 'revoked', identity: 'default', requests: 10, failedRequests: 0, spentUsd: { total: '1.000000' } },
    { label: 'Team', status: 'active', identity: 'team-a', requests: 50, failedRequests: 0, spentUsd: { total: '9.000000' } },
  ];
  // A seller's error can count in the buyer's usage, so failed requests are taken out of the history too.
  assert.deepEqual(parseWalletKeyUsage(keys, 'default'), { requests: 130, spentUsd: '5.25' });
  assert.deepEqual(parseWalletKeyUsage([], 'default'), { requests: 0, spentUsd: '0' });
  assert.deepEqual(parseWalletKeyUsage([null, { identity: 'default', requests: 'x', spentUsd: null }, { identity: 'default', requests: -4 }], 'default'), { requests: 0, spentUsd: '0' });
  assert.equal(parseWalletKeyUsage({ keys }, 'default'), null);
  assert.equal(parseWalletKeyUsage(null, 'default'), null);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { parseGatewayKeyInfo, withUsageOf } from './key-info.js';

test('key info is read from inside the gateway\'s data envelope', () => {
  assert.deepEqual(parseGatewayKeyInfo({
    data: {
      label: 'Desktop',
      buyer_address: '0xabc',
      usage: { requests: 3, spent_usd: '1.50' },
      limits: { daily: { limit_usd: '5.00', spent_usd: '1.50' } },
      balance: { available_usd: '12.500000', reserved_usd: '0.250000', stale: false },
    },
  }), {
    label: 'Desktop',
    buyerAddress: '0xabc',
    requests: 3,
    spentUsd: '1.50',
    limits: { daily: { limitUsd: '5.00', spentUsd: '1.50' } },
    balance: { availableUsd: '12.500000', reservedUsd: '0.250000', stale: false },
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

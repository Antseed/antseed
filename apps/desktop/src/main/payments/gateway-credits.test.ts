import assert from 'node:assert/strict';
import test from 'node:test';
import { gatewayCreditsInfo } from './gateway-credits.js';
import type { GatewayKeyBalance } from '../../shared/gateway-types.js';

const info = (balance: GatewayKeyBalance | null) => ({
  label: 'Desktop', buyerAddress: '0x00000000000000000000000000000000000000aa', requests: 0, spentUsd: '0', limits: {}, createdAt: null, balance,
});

const balance = (overrides: Partial<GatewayKeyBalance> = {}): GatewayKeyBalance => ({
  availableUsd: '12.500000', reservedUsd: '0.250000', pendingUsd: '0', walletUsd: '0', creditLimitUsd: '100.000000', operator: null, stale: false, ...overrides,
});

test('the balance is the wallet paying for the app\'s key, as its gateway reports it', () => {
  const credits = gatewayCreditsInfo(info(balance({ operator: '0x00000000000000000000000000000000000000bb' })));
  assert.equal(credits.evmAddress, '0x00000000000000000000000000000000000000aa');
  assert.equal(credits.operatorAddress, '0x00000000000000000000000000000000000000bb');
  assert.equal(credits.availableUsdc, '12.5');
  assert.equal(credits.reservedUsdc, '0.25');
  assert.equal(credits.balanceUsdc, '12.75');
  assert.equal(credits.creditLimitUsdc, '100');
  assert.equal(credits.balanceKnown, true);
});

test('spend signed but not settled is not the buyer\'s any more; unswept wallet USDC is', () => {
  const credits = gatewayCreditsInfo(info(balance({ pendingUsd: '0.200000', walletUsd: '3.000000' })));
  assert.equal(credits.pendingUsdc, '0.2');
  assert.equal(credits.spendableUsdc, '12.55');
  assert.equal(credits.walletUsdc, '3');
  assert.equal(credits.totalOwnedUsdc, '15.55');
});

test('the balance stays unknown when the gateway does not report it', () => {
  assert.equal(gatewayCreditsInfo(info(null)).balanceKnown, false);
  assert.equal(gatewayCreditsInfo(info(null)).totalOwnedUsdc, '0');
  assert.equal(gatewayCreditsInfo(null).evmAddress, null);
});

test('deposit rules are passed through for the local deposit flow', () => {
  const credits = gatewayCreditsInfo(info(balance()), { minFirstDepositUsdc: '2', depositFeeUsdc: '0.1' });
  assert.equal(credits.minFirstDepositUsdc, '2');
  assert.equal(credits.depositFeeUsdc, '0.1');
});

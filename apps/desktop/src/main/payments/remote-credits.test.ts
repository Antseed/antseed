import assert from 'node:assert/strict';
import test from 'node:test';
import { remoteCreditsInfo } from './remote-credits.js';

const info = (balance: { availableUsd: string; reservedUsd: string; stale: boolean } | null) => ({
  label: 'Desktop', buyerAddress: '0x00000000000000000000000000000000000000aa', requests: 0, spentUsd: '0', limits: {}, balance,
});

test('a remote gateway shows the wallet paying for its key: available plus what channels hold', () => {
  const credits = remoteCreditsInfo(info({ availableUsd: '12.500000', reservedUsd: '0.250000', stale: false }));
  assert.equal(credits.evmAddress, '0x00000000000000000000000000000000000000aa');
  assert.equal(credits.availableUsdc, '12.5');
  assert.equal(credits.reservedUsdc, '0.25');
  assert.equal(credits.balanceUsdc, '12.75');
  assert.equal(credits.totalOwnedUsdc, '12.75');
  assert.equal(credits.balanceKnown, true);
});

test('a remote balance stays unknown when the gateway does not report it', () => {
  assert.equal(remoteCreditsInfo(info(null)).balanceKnown, false);
  assert.equal(remoteCreditsInfo(info(null)).totalOwnedUsdc, '0');
  assert.equal(remoteCreditsInfo(null).evmAddress, null);
});

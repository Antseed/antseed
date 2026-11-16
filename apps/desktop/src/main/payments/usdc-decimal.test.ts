import assert from 'node:assert/strict';
import test from 'node:test';
import { usdcFromMicros, usdcToMicros } from './usdc-decimal.js';

test('USDC base units read as dollars without floats or trailing zeros', () => {
  assert.equal(usdcFromMicros(0n), '0');
  assert.equal(usdcFromMicros(1n), '0.000001');
  assert.equal(usdcFromMicros(1_500_000n), '1.5');
  assert.equal(usdcFromMicros(123_000_000n), '123');
});

test('dollar amounts read as base units; anything else is zero', () => {
  assert.equal(usdcToMicros('12.5'), 12_500_000n);
  assert.equal(usdcToMicros('0.000001'), 1n);
  assert.equal(usdcToMicros('1.0000009'), 1_000_000n);
  assert.equal(usdcToMicros(' 7 '), 7_000_000n);
  assert.equal(usdcToMicros('-1'), 0n);
  assert.equal(usdcToMicros('3e5'), 0n);
  assert.equal(usdcToMicros(null), 0n);
});

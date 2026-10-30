import test from 'node:test';
import assert from 'node:assert/strict';
import {
  attemptCountBucket, countBucket, durationBucket, sellersTriedBucket,
  smallCountBucket, telemetryHttpStatus, usdcAmountBucket,
} from './buckets.js';

test('buckets', () => {
  assert.equal(durationBucket(29_999), 'under_30s');
  assert.equal(durationBucket(300_000), 'over_5m');
  assert.equal(countBucket(0), '0');
  assert.equal(countBucket(5), '2_5');
  assert.equal(countBucket(21), '21_plus');
  assert.equal(smallCountBucket(3), '2_3');
  assert.equal(attemptCountBucket(7), '3_plus');
  assert.equal(sellersTriedBucket(2), '2');
  assert.equal(usdcAmountBucket(0n), 'zero');
  assert.equal(usdcAmountBucket(9_999n), 'under_0_01');
  assert.equal(usdcAmountBucket(1_000_000n), '1_10');
  assert.equal(usdcAmountBucket(10_000_000n), 'over_10');
  assert.equal(telemetryHttpStatus(502), 502);
  assert.equal(telemetryHttpStatus(42), undefined);
  assert.equal(telemetryHttpStatus(502.5), undefined);
});

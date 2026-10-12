import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit.js';

describe('TokenBucket', () => {
  it('serves a burst immediately, then paces at the refill rate', async () => {
    const bucket = new TokenBucket(100, 10);
    const start = Date.now();
    await bucket.take(10);
    expect(Date.now() - start).toBeLessThan(50);
    await bucket.take(5);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(40);
    expect(elapsed).toBeLessThan(400);
  });

  it('serves callers in arrival order and clamps requests to the burst size', async () => {
    const bucket = new TokenBucket(1000, 4);
    const order: string[] = [];
    await Promise.all([
      bucket.take(4).then(() => order.push('first')),
      bucket.take(40).then(() => order.push('second')),
      bucket.take(1).then(() => order.push('third')),
    ]);
    expect(order).toEqual(['first', 'second', 'third']);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { waitForAllowance } from './allowance';

function reads(...values: Array<bigint | undefined | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const value = values[Math.min(i++, values.length - 1)];
    if (value instanceof Error) throw value;
    return value;
  });
}

function recordingSleep() {
  const delays: number[] = [];
  return { delays, sleep: async (ms: number) => { delays.push(ms); } };
}

describe('waitForAllowance', () => {
  it('advances as soon as a stale read is followed by a fresh one', async () => {
    const read = reads(0n, 0n, 5_000_000n);
    const { delays, sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 5_000_000n, sleep })).resolves.toBe('covered');
    expect(read).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 1_500]);
  });

  it('resolves covered on the first read without waiting', async () => {
    const read = reads(10_000_000n);
    const { delays, sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 5_000_000n, sleep })).resolves.toBe('covered');
    expect(delays).toEqual([]);
  });

  it('reaches stale after the retry window when the allowance never updates', async () => {
    const read = reads(0n);
    const { delays, sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 5_000_000n, sleep })).resolves.toBe('stale');
    const total = delays.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThanOrEqual(30_000);
    expect(total).toBeLessThan(33_000);
    expect(Math.max(...delays)).toBe(3_000);
    expect(read).toHaveBeenCalledTimes(delays.length + 1);
  });

  it('gives up after about 30 s with the default timer-based sleep', async () => {
    vi.useFakeTimers();
    try {
      const read = reads(0n);
      const done = waitForAllowance({ read, required: 1n });
      await vi.advanceTimersByTimeAsync(33_000);
      await expect(done).resolves.toBe('stale');
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries read failures and reports failed when the last read fails', async () => {
    const read = reads(new Error('rpc down'));
    const { sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 1n, sleep })).resolves.toBe('failed');
    expect(read.mock.calls.length).toBeGreaterThan(1);
  });

  it('treats an undefined read as a failure and recovers once a read succeeds', async () => {
    const read = reads(undefined, new Error('timeout'), 2n);
    const { sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 2n, sleep })).resolves.toBe('covered');
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('stops when cancelled', async () => {
    let cancelled = false;
    const read = vi.fn(async () => { cancelled = true; return 0n; });
    const { sleep } = recordingSleep();
    await expect(waitForAllowance({ read, required: 1n, sleep, isCancelled: () => cancelled })).resolves.toBe('cancelled');
    expect(read).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MIN_GAS_BALANCE_WEI,
  GasHealthMonitor,
  type GasHealthEvent,
} from '../src/health/gas-health-monitor.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';

function makeMonitor(
  balances: Array<bigint | Error>,
  overrides: { minBalanceWei?: bigint; intervalMs?: number; relaxedIntervalMs?: number; relaxedBalanceFactor?: bigint } = {},
): { monitor: GasHealthMonitor; events: GasHealthEvent[]; calls: string[] } {
  const events: GasHealthEvent[] = [];
  const calls: string[] = [];
  const monitor = new GasHealthMonitor({
    address: ADDRESS,
    getBalance: async (address) => {
      calls.push(address);
      const next = balances.length > 1 ? balances.shift()! : balances[0]!;
      if (next instanceof Error) throw next;
      return next;
    },
    ...overrides,
    onChange: (event) => {
      events.push(event);
    },
  });
  return { monitor, events, calls };
}

describe('GasHealthMonitor', () => {
  it('stays quiet while the balance is at or above the threshold', async () => {
    const { monitor, events } = makeMonitor([DEFAULT_MIN_GAS_BALANCE_WEI]);
    await monitor.checkNow();
    expect(monitor.depleted).toBe(false);
    expect(events).toEqual([]);
  });

  it('emits depleted once when the balance drops below the threshold', async () => {
    const { monitor, events } = makeMonitor([0n]);
    await monitor.checkNow();
    await monitor.checkNow();
    expect(monitor.depleted).toBe(true);
    expect(events).toEqual([{
      status: 'depleted',
      address: ADDRESS,
      balanceWei: 0n,
      minBalanceWei: DEFAULT_MIN_GAS_BALANCE_WEI,
    }]);
  });

  it('drops a reading still in flight when it is stopped', async () => {
    const { monitor, events } = makeMonitor([0n], { intervalMs: 60_000 });
    monitor.start();
    monitor.stop();
    await monitor.checkNow();
    expect(events).toEqual([]);
    expect(monitor.depleted).toBe(false);
  });

  it('emits restored when the wallet is funded again', async () => {
    const { monitor, events } = makeMonitor([0n, DEFAULT_MIN_GAS_BALANCE_WEI * 2n]);
    await monitor.checkNow();
    await monitor.checkNow();
    expect(monitor.depleted).toBe(false);
    expect(events.map((event) => event.status)).toEqual(['depleted', 'restored']);
    expect(events[1]!.balanceWei).toBe(DEFAULT_MIN_GAS_BALANCE_WEI * 2n);
  });

  it('respects a custom threshold', async () => {
    const { monitor, events } = makeMonitor([5n], { minBalanceWei: 10n });
    await monitor.checkNow();
    expect(events[0]!.status).toBe('depleted');
    expect(events[0]!.minBalanceWei).toBe(10n);
  });

  it('treats RPC errors as inconclusive and keeps the current state', async () => {
    const { monitor, events } = makeMonitor([0n, new Error('rpc down'), 1_000_000_000_000_000n]);
    await monitor.checkNow();
    expect(monitor.depleted).toBe(true);
    await monitor.checkNow(); // RPC error — still depleted, no new event
    expect(monitor.depleted).toBe(true);
    expect(events).toHaveLength(1);
    await monitor.checkNow();
    expect(monitor.depleted).toBe(false);
    expect(events.map((event) => event.status)).toEqual(['depleted', 'restored']);
  });

  it('coalesces concurrent checks into one balance read', async () => {
    const { monitor, calls } = makeMonitor([DEFAULT_MIN_GAS_BALANCE_WEI]);
    await Promise.all([monitor.checkNow(), monitor.checkNow(), monitor.checkNow()]);
    expect(calls).toHaveLength(1);
  });

  it('polls on the configured interval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const { monitor, events, calls } = makeMonitor([0n], { intervalMs: 1_000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0); // initial check
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(calls).toHaveLength(3);
      expect(events).toHaveLength(1); // only the first crossing emits
      monitor.stop();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks a well-funded wallet only every relaxed interval, and tightens up near the line', async () => {
    vi.useFakeTimers();
    try {
      const plenty = DEFAULT_MIN_GAS_BALANCE_WEI * 50n;
      const { monitor, calls } = makeMonitor([plenty, plenty, DEFAULT_MIN_GAS_BALANCE_WEI * 2n], { intervalMs: 2_000, relaxedIntervalMs: 10_000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(9_000);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(calls).toHaveLength(3);
      // 2× the minimum is not well funded: back to every regular interval.
      await vi.advanceTimersByTimeAsync(6_000);
      expect(calls).toHaveLength(6);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('never relaxes past five regular intervals', async () => {
    vi.useFakeTimers();
    try {
      const { monitor, calls } = makeMonitor([DEFAULT_MIN_GAS_BALANCE_WEI * 50n], { intervalMs: 1_000, relaxedIntervalMs: 60_000 });
      monitor.start();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toHaveLength(2);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('takes a higher well-funded factor from its config', async () => {
    vi.useFakeTimers();
    try {
      const { monitor, calls } = makeMonitor([DEFAULT_MIN_GAS_BALANCE_WEI * 50n], { intervalMs: 1_000, relaxedIntervalMs: 10_000, relaxedBalanceFactor: 100n });
      monitor.start();
      await vi.advanceTimersByTimeAsync(3_000);
      expect(calls).toHaveLength(4);
      monitor.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a snapshot of the last reading', async () => {
    const { monitor } = makeMonitor([7n], { minBalanceWei: 10n });
    expect(monitor.getSnapshot()).toMatchObject({
      address: ADDRESS,
      depleted: false,
      lastBalanceWei: null,
      lastCheckedAt: null,
    });
    await monitor.checkNow();
    const snapshot = monitor.getSnapshot();
    expect(snapshot.depleted).toBe(true);
    expect(snapshot.lastBalanceWei).toBe(7n);
    expect(snapshot.lastCheckedAt).not.toBeNull();
  });

  it('does not let an onChange failure break the check loop', async () => {
    const balances = [0n, DEFAULT_MIN_GAS_BALANCE_WEI];
    const events: string[] = [];
    const monitor = new GasHealthMonitor({
      address: ADDRESS,
      getBalance: async () => balances.shift() ?? DEFAULT_MIN_GAS_BALANCE_WEI,
      onChange: (event) => {
        events.push(event.status);
        throw new Error('handler blew up');
      },
    });
    await monitor.checkNow();
    await monitor.checkNow();
    expect(events).toEqual(['depleted', 'restored']);
  });
});

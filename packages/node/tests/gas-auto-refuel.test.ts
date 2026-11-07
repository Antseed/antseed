import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REFUEL_TRIGGER_WEI,
  GasAutoRefueler,
  REFUEL_FAILURE_BACKOFF_MS,
  REFUEL_SUCCESS_COOLDOWN_MS,
  swapCertainlyNotSpent,
  type GasRefuelEvent,
  type GasRefuelRecord,
  type GasRefuelSwapper,
} from '../src/health/gas-auto-refuel.js';
import { GasHealthMonitor } from '../src/health/gas-health-monitor.js';

const ADDRESS = '0x1111111111111111111111111111111111111111';
const USDC = (n: number) => BigInt(Math.round(n * 1e6));
const LOW = DEFAULT_REFUEL_TRIGGER_WEI - 1n;

function setup(opts: {
  usdcBalance?: bigint;
  maxCostWei?: bigint;
  swapError?: Error;
  history?: GasRefuelRecord[];
  swapUsdcUnits?: bigint;
  maxUsdcPerDayUnits?: bigint;
} = {}) {
  let now = 1_000_000_000;
  const swaps: Array<{ amountIn: bigint; minEthOut: bigint }> = [];
  const events: GasRefuelEvent[] = [];
  const swapper: GasRefuelSwapper = {
    quote: async (amountIn) => amountIn * 400_000_000n, // 1 USDC ≈ 0.0004 ETH
    usdcBalance: async () => opts.usdcBalance ?? USDC(100),
    maxSwapCostWei: async () => opts.maxCostWei ?? 3_000_000_000_000n,
    swap: async (amountIn, minEthOut) => {
      if (opts.swapError) throw opts.swapError;
      swaps.push({ amountIn, minEthOut });
      return `0xtx${swaps.length}`;
    },
  };
  const refueler = new GasAutoRefueler({
    address: ADDRESS,
    swapper,
    history: opts.history,
    ...(opts.swapUsdcUnits !== undefined ? { swapUsdcUnits: opts.swapUsdcUnits } : {}),
    ...(opts.maxUsdcPerDayUnits !== undefined ? { maxUsdcPerDayUnits: opts.maxUsdcPerDayUnits } : {}),
    onEvent: (event) => { events.push(event); },
    now: () => now,
  });
  return { refueler, swaps, events, advance: (ms: number) => { now += ms; }, now: () => now };
}

describe('GasAutoRefueler', () => {
  it('does nothing while the balance is at or above the trigger', async () => {
    const { refueler, swaps, events } = setup();
    await refueler.onBalance(DEFAULT_REFUEL_TRIGGER_WEI);
    expect(swaps).toEqual([]);
    expect(events).toEqual([]);
  });

  it('swaps the configured USDC with 1% slippage when the balance drops under the trigger', async () => {
    const { refueler, swaps, events } = setup();
    await refueler.onBalance(LOW);
    const expected = USDC(10) * 400_000_000n;
    expect(swaps).toEqual([{ amountIn: USDC(10), minEthOut: (expected * 9_900n) / 10_000n }]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ status: 'refueled', expectedEthWei: expected, record: { usdcUnits: '10000000', txHash: '0xtx1' } });
    expect(refueler.getSnapshot().usdcLast24hUnits).toBe(USDC(10));
  });

  it('runs one refuel at a time and waits out the cooldown before another', async () => {
    const { refueler, swaps, advance } = setup();
    await Promise.all([refueler.onBalance(LOW), refueler.onBalance(LOW)]);
    expect(swaps).toHaveLength(1);
    advance(REFUEL_SUCCESS_COOLDOWN_MS - 1);
    await refueler.onBalance(LOW);
    expect(swaps).toHaveLength(1);
    advance(1);
    await refueler.onBalance(LOW);
    expect(swaps).toHaveLength(2);
  });

  it('caps the USDC swapped per 24 hours, counting refuels from before a restart', async () => {
    const start = 1_000_000_000;
    const { refueler, swaps, events, advance } = setup({
      history: [{ at: start - 60_000, usdcUnits: USDC(25).toString(), txHash: '0xold' }],
    });
    await refueler.onBalance(LOW);
    expect(swaps.map((s) => s.amountIn)).toEqual([USDC(5)]);
    advance(REFUEL_SUCCESS_COOLDOWN_MS);
    await refueler.onBalance(LOW);
    expect(swaps).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ status: 'skipped', reason: 'daily_cap' });
    // The old refuel ages out of the window: 25 USDC frees up.
    advance(24 * 60 * 60_000);
    await refueler.onBalance(LOW);
    expect(swaps.map((s) => s.amountIn)).toEqual([USDC(5), USDC(10)]);
  });

  it('swaps only what the wallet holds and skips below 1 USDC, reporting the skip once', async () => {
    const partial = setup({ usdcBalance: USDC(3.5) });
    await partial.refueler.onBalance(LOW);
    expect(partial.swaps.map((s) => s.amountIn)).toEqual([USDC(3.5)]);

    const empty = setup({ usdcBalance: USDC(0.5) });
    await empty.refueler.onBalance(LOW);
    empty.advance(REFUEL_SUCCESS_COOLDOWN_MS);
    await empty.refueler.onBalance(LOW);
    expect(empty.swaps).toEqual([]);
    expect(empty.events).toEqual([expect.objectContaining({ status: 'skipped', reason: 'insufficient_usdc' })]);
  });

  it('skips when the wallet cannot pay for the swap itself', async () => {
    const { refueler, swaps, events } = setup({ maxCostWei: LOW + 1n });
    await refueler.onBalance(LOW);
    expect(swaps).toEqual([]);
    expect(events).toEqual([expect.objectContaining({ status: 'skipped', reason: 'insufficient_eth' })]);
  });

  it('backs off exponentially after failures', async () => {
    const { refueler, events, advance } = setup({ swapError: Object.assign(new Error('execution reverted: Too little received'), { code: 'CALL_EXCEPTION' }) });
    await refueler.onBalance(LOW);
    expect(events).toEqual([expect.objectContaining({ status: 'failed', error: 'execution reverted: Too little received' })]);
    expect(refueler.getSnapshot().lastError).toBe('execution reverted: Too little received');
    advance(REFUEL_FAILURE_BACKOFF_MS);
    await refueler.onBalance(LOW);
    expect(events).toHaveLength(2);
    advance(REFUEL_FAILURE_BACKOFF_MS);
    await refueler.onBalance(LOW);
    expect(events).toHaveLength(2);
    advance(REFUEL_FAILURE_BACKOFF_MS);
    await refueler.onBalance(LOW);
    expect(events).toHaveLength(3);
  });

  it('saves a refuel that completes after stop(), and stop() waits for it', async () => {
    let finishSwap!: (hash: string) => void;
    const saved: GasRefuelRecord[][] = [];
    const events: GasRefuelEvent[] = [];
    const refueler = new GasAutoRefueler({
      address: ADDRESS,
      swapper: {
        quote: async (amountIn) => amountIn,
        usdcBalance: async () => USDC(100),
        maxSwapCostWei: async () => 1n,
        swap: () => new Promise<string>((resolve) => { finishSwap = resolve; }),
      },
      saveHistory: async (records) => { saved.push(records); },
      onEvent: (event) => { events.push(event); },
    });
    const running = refueler.onBalance(LOW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stopped = refueler.stop();
    finishSwap('0xlate');
    await Promise.all([running, stopped]);
    expect(saved.at(-1)).toEqual([{ at: expect.any(Number), txHash: '0xlate', usdcUnits: '10000000' }]);
    expect(events).toEqual([]);
  });

  it('saves the spend as pending before sending, so a restart mid-swap still counts it toward the daily cap', async () => {
    const saved: GasRefuelRecord[][] = [];
    const swapper: GasRefuelSwapper = {
      quote: async (amountIn) => amountIn,
      usdcBalance: async () => USDC(100),
      maxSwapCostWei: async () => 1n,
      swap: () => new Promise<string>(() => {}), // never mined before the process exits
    };
    const first = new GasAutoRefueler({ address: ADDRESS, swapper, maxUsdcPerDayUnits: USDC(15), saveHistory: async (records) => { saved.push(records); } });
    void first.onBalance(LOW);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(saved).toEqual([[{ at: expect.any(Number), usdcUnits: '10000000', txHash: '', pending: true }]]);
    expect(first.getSnapshot().lastRefuel).toBeNull();

    // The restarted seller loads that history: only 5 USDC of the 15 cap is left.
    const swaps: bigint[] = [];
    const second = new GasAutoRefueler({
      address: ADDRESS, maxUsdcPerDayUnits: USDC(15), history: saved.at(-1),
      swapper: { ...swapper, swap: async (amountIn) => { swaps.push(amountIn); return '0xnext'; } },
    });
    await second.onBalance(LOW);
    expect(swaps).toEqual([USDC(5)]);
  });

  const failingSwap = (error: unknown) => {
    const saved: GasRefuelRecord[][] = [];
    let swaps = 0;
    const refueler = new GasAutoRefueler({
      address: ADDRESS,
      swapper: { quote: async (a) => a, usdcBalance: async () => USDC(100), maxSwapCostWei: async () => 1n, swap: async () => { swaps += 1; throw error; } },
      saveHistory: async (records) => { saved.push(records); },
    });
    return { refueler, saved, swaps: () => swaps };
  };

  it('drops the pending spend when the swap certainly spent nothing (a revert)', async () => {
    const { refueler, saved } = failingSwap(Object.assign(new Error('execution reverted: Too little received'), { code: 'CALL_EXCEPTION' }));
    await refueler.onBalance(LOW);
    expect(saved.map((records) => records.length)).toEqual([1, 0]);
    expect(refueler.getSnapshot().usdcLast24hUnits).toBe(0n);
  });

  it('keeps counting the pending spend when the swap may have been broadcast (the RPC response was lost)', async () => {
    const { refueler, saved } = failingSwap(Object.assign(new Error('request timeout'), { code: 'TIMEOUT' }));
    await refueler.onBalance(LOW);
    expect(saved).toEqual([[expect.objectContaining({ pending: true, usdcUnits: '10000000' })]]);
    expect(refueler.getSnapshot().usdcLast24hUnits).toBe(USDC(10));
  });

  it('sends no swap when the reservation cannot be saved', async () => {
    let swaps = 0;
    const events: GasRefuelEvent[] = [];
    const refueler = new GasAutoRefueler({
      address: ADDRESS,
      swapper: { quote: async (a) => a, usdcBalance: async () => USDC(100), maxSwapCostWei: async () => 1n, swap: async () => { swaps += 1; return '0x'; } },
      saveHistory: async () => { throw new Error('EACCES: permission denied'); },
      onEvent: (event) => { events.push(event); },
    });
    await refueler.onBalance(LOW);
    expect(swaps).toBe(0);
    expect(refueler.getSnapshot().usdcLast24hUnits).toBe(0n);
    expect(events).toEqual([expect.objectContaining({ status: 'failed', error: expect.stringContaining('could not save the refuel reservation') })]);
  });

  it('tells a certain non-spend from an uncertain one', () => {
    expect(swapCertainlyNotSpent(Object.assign(new Error('x'), { code: 'CALL_EXCEPTION' }))).toBe(true);
    expect(swapCertainlyNotSpent(Object.assign(new Error('x'), { code: 'INSUFFICIENT_FUNDS' }))).toBe(true);
    expect(swapCertainlyNotSpent(new Error('Transaction was dropped or replaced'))).toBe(true);
    expect(swapCertainlyNotSpent(Object.assign(new Error('x'), { code: 'TIMEOUT' }))).toBe(false);
    expect(swapCertainlyNotSpent(new Error('fetch failed'))).toBe(false);
  });

  it('reports nothing and starts nothing after stop()', async () => {
    const { refueler, swaps, events } = setup();
    refueler.stop();
    await refueler.onBalance(LOW);
    expect(swaps).toEqual([]);
    expect(events).toEqual([]);
  });

  it('is fed every reading by GasHealthMonitor', async () => {
    const readings: bigint[] = [];
    const monitor = new GasHealthMonitor({
      address: ADDRESS,
      getBalance: async () => 123n,
      onBalance: (balanceWei) => { readings.push(balanceWei); },
    });
    await monitor.checkNow();
    await monitor.checkNow();
    expect(readings).toEqual([123n, 123n]);
  });
});

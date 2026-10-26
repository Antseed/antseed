import { afterEach, describe, expect, it, vi } from 'vitest';

const stake = (power: number) => ({ buyer: '0xb1', currentEpoch: 10, genesis: 0, epochDuration: 604_800, pools: [{ agentId: power, positions: [] }] });

function fakeWindow(read: () => Promise<unknown>) {
  const target = new EventTarget();
  vi.stubGlobal('window', Object.assign(target, { antseedDesktop: { freeTierStake: read } }));
  return target;
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe('counted stake store', () => {
  it('re-reads on a timer and on focus while subscribed, and stops after the last unsubscribe', async () => {
    vi.useFakeTimers();
    let reads = 0;
    const win = fakeWindow(async () => ({ ok: true, data: stake(++reads) }));
    const { FREE_TIER_STAKE_REFRESH_MS, getFreeTierStake, subscribeFreeTierStake } = await import('./useFreeTierStake');
    const seen: number[] = [];
    const unsubscribe = subscribeFreeTierStake(() => seen.push(getFreeTierStake()!.pools[0]!.agentId));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1]);

    // A mounted view picks up stake changed elsewhere after the refresh interval.
    await vi.advanceTimersByTimeAsync(FREE_TIER_STAKE_REFRESH_MS);
    expect(seen).toEqual([1, 2]);

    // Coming back to the window re-reads, at most once every 30 seconds.
    await vi.advanceTimersByTimeAsync(30_000);
    win.dispatchEvent(new Event('focus'));
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(seen).toEqual([1, 2, 3]);

    unsubscribe();
    await vi.advanceTimersByTimeAsync(FREE_TIER_STAKE_REFRESH_MS * 2);
    win.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(3);
  });

  it('keeps the last stake when a read fails', async () => {
    vi.useFakeTimers();
    let fail = false;
    fakeWindow(async () => (fail ? { ok: false, error: 'rpc down' } : { ok: true, data: stake(7) }));
    const { FREE_TIER_STAKE_REFRESH_MS, getFreeTierStake, subscribeFreeTierStake } = await import('./useFreeTierStake');
    const unsubscribe = subscribeFreeTierStake(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fail = true;
    await vi.advanceTimersByTimeAsync(FREE_TIER_STAKE_REFRESH_MS);
    expect(getFreeTierStake()?.pools[0]?.agentId).toBe(7);
    unsubscribe();
  });
});

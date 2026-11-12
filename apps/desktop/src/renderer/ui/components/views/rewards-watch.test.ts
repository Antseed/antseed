import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayRewardsSummary } from '../../../types/bridge';
import { REWARDS_REFRESH_MS, watchRewards } from './rewards-watch';

const summary = (pendingAnts: string): GatewayRewardsSummary => ({ available: true, address: '0xabc', pendingAnts, currentEpoch: 3, transfersEnabled: false });
const flush = () => vi.advanceTimersByTimeAsync(0);

describe('watchRewards', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('reads again on focus and on the interval, and stops cleanly', async () => {
    const target = new EventTarget();
    let pending = '1';
    const read = vi.fn(async () => ({ ok: true, data: summary(pending) }));
    const shown: string[] = [];
    const stop = watchRewards(read, (rewards) => shown.push(rewards.pendingAnts), { target });
    await flush();
    expect(shown).toEqual(['1']);

    // Claimed in the console: the window regains focus.
    pending = '0';
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(shown).toEqual(['1', '0']);

    // Earned while Home stays open.
    pending = '2';
    await vi.advanceTimersByTimeAsync(REWARDS_REFRESH_MS);
    expect(shown).toEqual(['1', '0', '2']);

    stop();
    pending = '9';
    target.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(REWARDS_REFRESH_MS);
    expect(shown).toEqual(['1', '0', '2']);
  });

  it('keeps what is shown on a failed read and drops an overtaken answer', async () => {
    const target = new EventTarget();
    const slow = { resolve: (_: unknown) => undefined as void };
    const read = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { slow.resolve = resolve; }))
      .mockResolvedValueOnce({ ok: true, data: summary('5') })
      .mockResolvedValueOnce({ ok: false, error: 'offline' })
      .mockRejectedValueOnce(new Error('gone'));
    const shown: string[] = [];
    const stop = watchRewards(read, (rewards) => shown.push(rewards.pendingAnts), { target });
    target.dispatchEvent(new Event('focus'));
    await flush();
    slow.resolve({ ok: true, data: summary('old') });
    await flush();
    expect(shown).toEqual(['5']);
    target.dispatchEvent(new Event('focus'));
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(shown).toEqual(['5']);
    stop();
  });
});

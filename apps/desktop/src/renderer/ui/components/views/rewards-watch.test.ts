import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GatewayRewardsSummary } from '../../../types/bridge';
import { REWARDS_REFRESH_MS, watchRewards } from './rewards-watch';
import { rewardsHint } from './VprRewardsView';

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

  it('reads again on its own while the screen stays open and focused, with no navigation', async () => {
    const target = new EventTarget();
    let pending = '1';
    const shown: string[] = [];
    const stop = watchRewards(async () => ({ ok: true, data: summary(pending) }), (rewards) => shown.push(rewards.pendingAnts), { target });
    await flush();
    pending = '3';
    await vi.advanceTimersByTimeAsync(REWARDS_REFRESH_MS);
    pending = '4';
    await vi.advanceTimersByTimeAsync(REWARDS_REFRESH_MS);
    expect(shown).toEqual(['1', '3', '4']);
    stop();
  });

  it('a failed refresh after a successful read keeps the amount and says it couldn\'t refresh', async () => {
    const target = new EventTarget();
    let rewards: GatewayRewardsSummary | null = null;
    let error: string | null = null;
    const read = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: summary('7') })
      .mockResolvedValueOnce({ ok: false, error: 'gateway unreachable' })
      .mockResolvedValueOnce({ ok: true, data: summary('7') })
      .mockRejectedValueOnce(new Error('IPC closed'));
    const stop = watchRewards(read, (value) => { rewards = value; error = null; }, { target, onError: (value) => { error = value; } });
    await flush();
    expect(rewardsHint(rewards, error)).toContain('Earned by your gateway');
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(rewards).not.toBeNull();
    expect(rewardsHint(rewards, error)).toBe('Couldn\'t refresh your rewards: gateway unreachable');
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(rewardsHint(rewards, error)).toContain('Earned by your gateway');
    target.dispatchEvent(new Event('focus'));
    await flush();
    expect(rewardsHint(rewards, error)).toBe('Couldn\'t refresh your rewards: IPC closed');
    stop();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { clearDisplayStakerRewards, displayStakerRewards } from './staker-rewards.js';

function fixture() {
  const previewStakerRewards = vi.fn(async (ids: number[]) => ids.map((id) => BigInt(id * 10)));
  const ctx = { poolRewards: () => ({ previewStakerRewards }) } as unknown as AntsContext;
  return { ctx, previewStakerRewards };
}

describe('shared staker reward previews', () => {
  it('previews ids once when concurrent views request them', async () => {
    const { ctx, previewStakerRewards } = fixture();
    const [positions, rewards] = await Promise.all([displayStakerRewards(ctx, [3, 1, 2]), displayStakerRewards(ctx, [1, 2, 3, 4])]);
    expect(positions).toEqual([30n, 10n, 20n]);
    expect(rewards).toEqual([10n, 20n, 30n, 40n]);
    expect(previewStakerRewards.mock.calls).toEqual([[[3, 1, 2]], [[4]]]);
  });

  it('reads again after invalidation and does not cache failures', async () => {
    const { ctx, previewStakerRewards } = fixture();
    await displayStakerRewards(ctx, [1]);
    clearDisplayStakerRewards(ctx);
    await displayStakerRewards(ctx, [1]);
    expect(previewStakerRewards).toHaveBeenCalledTimes(2);
    previewStakerRewards.mockRejectedValueOnce(new Error('RPC down'));
    clearDisplayStakerRewards(ctx);
    await expect(displayStakerRewards(ctx, [5])).rejects.toThrow('RPC down');
    await expect(displayStakerRewards(ctx, [5])).resolves.toEqual([50n]);
  });

  it('expires shared previews', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, previewStakerRewards } = fixture();
      await displayStakerRewards(ctx, [1]);
      vi.advanceTimersByTime(15_001);
      await displayStakerRewards(ctx, [1]);
      expect(previewStakerRewards).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });
});

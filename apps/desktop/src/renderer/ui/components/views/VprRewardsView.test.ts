import { describe, expect, it } from 'vitest';
import { rewardsHint, rewardsValue } from './VprRewardsView';

const summary = { available: true, address: '0x00000000000000000000000000000000000000aa', pendingAnts: '12.5', currentEpoch: 30, transfersEnabled: false };

describe('rewards display', () => {
  it('shows the amount with its wallet and epoch once read', () => {
    expect(rewardsValue(summary, null)).not.toBe('—');
    expect(rewardsHint(summary, null)).toBe('Earned by your gateway\'s wallet 0x0000…00aa from usage · epoch 30.');
  });

  it('reads as loading, failed, unsupported and not live, in that precedence', () => {
    expect([rewardsValue(null, null), rewardsHint(null, null)]).toEqual(['…', 'Reading your rewards…']);
    expect([rewardsValue(null, 'offline'), rewardsHint(null, 'offline')]).toEqual(['—', 'offline']);
    const old = { ...summary, remoteChainUnverified: true as const };
    expect(rewardsValue(old, 'later error')).toBe('—');
    expect(rewardsHint(old, null)).toContain('see them in your gateway');
    expect(rewardsHint({ ...summary, available: false }, null)).toBe('Rewards are not live on this network yet.');
  });
});

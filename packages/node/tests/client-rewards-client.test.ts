import { describe, expect, it, vi } from 'vitest';
import { ClientRewardsClient } from '../src/payments/evm/client-rewards-client.js';
import { resolveChainConfig } from '../src/payments/chain-config.js';

function client() {
  return new ClientRewardsClient({ rpcUrl: 'http://localhost:8545', contractAddress: '0x' + '4'.repeat(40) });
}

describe('ClientRewardsClient', () => {
  it('scans only the claimable epochs and keeps non-zero rewards, oldest first', async () => {
    const rewards = client();
    vi.spyOn(rewards, 'currentEpoch').mockResolvedValue(10);
    const pending = vi.spyOn(rewards, 'pendingReward').mockImplementation(async (_agentId, epoch) => (epoch % 3 === 0 ? BigInt(epoch) : 0n));
    expect(await rewards.pendingRewards(7, 4)).toEqual([{ epoch: 6, amount: 6n }, { epoch: 9, amount: 9n }]);
    // current 10 → epochs 6..9 (an epoch is claimable once it ends)
    expect(pending.mock.calls.map((call) => call[1])).toEqual([6, 7, 8, 9]);
    expect(pending.mock.calls.every((call) => call[0] === 7)).toBe(true);
  });

  it('returns nothing before any epoch is claimable', async () => {
    const rewards = client();
    vi.spyOn(rewards, 'currentEpoch').mockResolvedValue(0);
    const pending = vi.spyOn(rewards, 'pendingReward');
    expect(await rewards.pendingRewards(7)).toEqual([]);
    expect(pending).not.toHaveBeenCalled();
  });

  it('is configurable through resolveChainConfig', () => {
    const address = '0x' + '5'.repeat(40);
    expect(resolveChainConfig({ chainId: 'base-local', clientRewardsAddress: address }).clientRewardsAddress).toBe(address);
    expect(resolveChainConfig({ chainId: 'base-local' }).clientRewardsAddress).toBeUndefined();
  });
});

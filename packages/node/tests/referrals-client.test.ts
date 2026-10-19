import { describe, expect, it, vi } from 'vitest';
import { ReferralsClient } from '../src/payments/evm/referrals-client.js';

function client() {
  return new ReferralsClient({ rpcUrl: 'http://localhost:8545', contractAddress: '0x' + '6'.repeat(40) });
}

describe('ReferralsClient reward scans', () => {
  it('scans referrer and referee rewards in an explicit range, up to the latest claimable epoch by default', async () => {
    const referrals = client();
    vi.spyOn(referrals, 'currentEpoch').mockResolvedValue(12);
    const referrer = vi.spyOn(referrals, 'pendingReward').mockImplementation(async (_wallet, epoch) => (epoch === 4 ? 2n : 0n));
    const referee = vi.spyOn(referrals, 'pendingRefereeReward').mockImplementation(async (_wallet, epoch) => (epoch === 9 ? 3n : 0n));
    expect(await referrals.pendingRewards('0x1', { fromEpoch: 3, toEpoch: 5 })).toEqual([{ epoch: 4, amount: 2n }]);
    expect(referrer.mock.calls.map((call) => call[1])).toEqual([3, 4, 5]);
    // No `toEpoch`: up to epoch 10 (current 12, epoch 11 still in its settlement grace).
    expect(await referrals.pendingRefereeRewards('0x2', { fromEpoch: 8 })).toEqual([{ epoch: 9, amount: 3n }]);
    expect(referee.mock.calls.map((call) => call[1])).toEqual([8, 9, 10]);
  });
});

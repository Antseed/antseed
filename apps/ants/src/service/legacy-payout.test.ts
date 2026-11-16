import { Interface, ZeroAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { legacySellerPayout } from './legacy-payout.js';

const seller = '0x0000000000000000000000000000000000000001';
const pool = '0x0000000000000000000000000000000000000002';
const policy = '0x0000000000000000000000000000000000000003';
const emissions = '0x0000000000000000000000000000000000000004';
const policyInterface = new Interface(['function canClaimSellerUnlocked(address seller) view returns (bool)']);

function fixture(allowed = false) {
  const call = vi.fn(async () => policyInterface.encodeFunctionResult('canClaimSellerUnlocked', [allowed]));
  const legacy = { sellerUnlockPolicy: vi.fn(async () => policy), sellerRewardsPool: vi.fn(async () => pool) };
  const ctx = { address: seller, legacyEmissionsAt: () => legacy, provider: () => ({ call }) } as unknown as AntsContext;
  return { ctx, legacy, call };
}

describe('legacy seller payout destination', () => {
  it.each([true, false])('uses actual seller eligibility (unlocked: %s)', async (allowed) => {
    const setup = fixture(allowed);
    expect(await legacySellerPayout(setup.ctx, emissions)).toEqual({ destination: allowed ? 'wallet' : 'locked', recipient: allowed ? seller : pool });
    expect(setup.call).toHaveBeenCalledWith({ from: emissions, to: policy, data: policyInterface.encodeFunctionData('canClaimSellerUnlocked', [seller]) });
  });
  it('uses the locked pool when no seller unlock policy is installed', async () => {
    const setup = fixture();
    setup.legacy.sellerUnlockPolicy.mockResolvedValue(ZeroAddress);
    expect(await legacySellerPayout(setup.ctx, emissions)).toEqual({ destination: 'locked', recipient: pool });
    expect(setup.call).not.toHaveBeenCalled();
  });
  it('matches the contract’s locked fallback when the policy reverts', async () => {
    const setup = fixture();
    setup.call.mockRejectedValue(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION' }));
    expect(await legacySellerPayout(setup.ctx, emissions)).toEqual({ destination: 'locked', recipient: pool });
  });
  it.each(['policy', 'eligibility', 'pool', 'decode', 'missing-pool'])('does not guess a destination on unavailable data: %s', async (failure) => {
    const setup = fixture();
    if (failure === 'policy') setup.legacy.sellerUnlockPolicy.mockRejectedValue(new Error('RPC unavailable'));
    if (failure === 'eligibility') setup.call.mockRejectedValue(new Error('RPC unavailable'));
    if (failure === 'pool') setup.legacy.sellerRewardsPool.mockRejectedValue(new Error('RPC unavailable'));
    if (failure === 'decode') setup.call.mockResolvedValue('0x');
    if (failure === 'missing-pool') setup.legacy.sellerRewardsPool.mockResolvedValue(ZeroAddress);
    expect(await legacySellerPayout(setup.ctx, emissions)).toEqual({ destination: 'unknown', recipient: null });
  });
});

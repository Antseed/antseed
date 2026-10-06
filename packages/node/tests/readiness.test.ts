import { describe, it, expect, vi } from 'vitest';
import { Wallet } from 'ethers';
import { checkSellerReadiness, checkBuyerReadiness } from '../src/payments/readiness.js';
import type { Identity } from '../src/p2p/identity.js';
import type { DepositsClient } from '../src/payments/evm/deposits-client.js';
import type { IdentityClient } from '../src/payments/evm/identity-client.js';
import type { StakingClient } from '../src/payments/evm/staking-client.js';
import { toPeerId } from '../src/types/peer.js';
import { bytesToHex } from '../src/utils/hex.js';

// Deterministic fake identity
const seed = new Uint8Array(32).fill(1);
const wallet = new Wallet('0x' + bytesToHex(seed));
const fakeIdentity: Identity = {
  peerId: toPeerId(wallet.address.slice(2).toLowerCase()),
  privateKey: seed,
  wallet,
};

function mockStakingClient(overrides: {
  ethBalance?: bigint;
  sellerStake?: bigint;
  eligible?: boolean;
} = {}): StakingClient {
  return {
    provider: {
      getBalance: vi.fn().mockResolvedValue(overrides.ethBalance ?? 1000000000000000n),
    },
    isStakedAboveMin: vi.fn().mockResolvedValue(overrides.eligible ?? true),
    getStake: vi.fn().mockResolvedValue(overrides.sellerStake ?? 10_000_000n),
  } as unknown as StakingClient;
}

function mockDepositsClient(overrides: {
  ethBalance?: bigint;
  buyerAvailable?: bigint;
} = {}): DepositsClient {
  return {
    provider: {
      getBalance: vi.fn().mockResolvedValue(overrides.ethBalance ?? 1000000000000000n),
    },
    getBuyerBalance: vi.fn().mockResolvedValue({
      available: overrides.buyerAvailable ?? 5_000_000n,
      reserved: 0n,
      lastActivityAt: 0n,
    }),
  } as unknown as DepositsClient;
}

function mockIdentityClient(overrides: {
  isRegistered?: boolean;
} = {}): IdentityClient {
  return {
    isRegistered: vi.fn().mockResolvedValue(overrides.isRegistered ?? true),
  } as unknown as IdentityClient;
}

describe('checkSellerReadiness', () => {
  it('all checks pass when seller is fully set up', async () => {
    const staking = mockStakingClient();
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, identity, staking);

    expect(checks).toHaveLength(3);
    expect(checks.every(c => c.passed)).toBe(true);
    expect(checks.every(c => c.command === undefined)).toBe(true);
  });

  it('fails gas check when ETH balance is zero', async () => {
    const staking = mockStakingClient({ ethBalance: 0n });
    const identity = mockIdentityClient();

    const checks = await checkSellerReadiness(fakeIdentity, identity, staking);

    const gasCheck = checks.find(c => c.name === 'Gas balance')!;
    expect(gasCheck.passed).toBe(false);
    expect(gasCheck.message).toContain('No ETH for gas');
  });

  it('fails registration check when not registered', async () => {
    const staking = mockStakingClient();
    const identity = mockIdentityClient({ isRegistered: false });

    const checks = await checkSellerReadiness(fakeIdentity, identity, staking);

    const regCheck = checks.find(c => c.name === 'Peer registration')!;
    expect(regCheck.passed).toBe(false);
    expect(regCheck.command).toBe('antseed seller register');
  });

  it('accepts an eligible zero-stake seller', async () => {
    const staking = mockStakingClient({ sellerStake: 0n, eligible: true });

    const checks = await checkSellerReadiness(fakeIdentity, mockIdentityClient(), staking);

    expect(checks.every(c => c.passed)).toBe(true);
    expect(checks.every(c => c.command === undefined)).toBe(true);
    expect(staking.isStakedAboveMin).toHaveBeenCalledWith(fakeIdentity.wallet.address);
    expect(staking.getStake).not.toHaveBeenCalled();
  });

  it.each([0n, 10_000_000n])('rejects an ineligible seller with stake %s', async (sellerStake) => {
    const staking = mockStakingClient({ sellerStake, eligible: false });

    const checks = await checkSellerReadiness(fakeIdentity, mockIdentityClient(), staking);

    const stakeCheck = checks.find(c => c.name === 'Stake')!;
    expect(stakeCheck.passed).toBe(false);
    expect(stakeCheck.message).toContain('Check agent binding and required stake');
    expect(stakeCheck.command).toBe('antseed seller status');
  });

  it('propagates eligibility RPC errors rather than treating the seller as ready', async () => {
    const staking = mockStakingClient();
    vi.mocked(staking.isStakedAboveMin).mockRejectedValue(new Error('RPC unavailable'));

    await expect(checkSellerReadiness(fakeIdentity, mockIdentityClient(), staking))
      .rejects.toThrow('RPC unavailable');
  });

  it('checks registration and stake against the configured seller contract', async () => {
    const staking = mockStakingClient();
    const identityClient = mockIdentityClient();
    const sellerContract = '0x1234567890abcdef1234567890abcdef12345678';

    await checkSellerReadiness(fakeIdentity, identityClient, staking, sellerContract);

    expect(staking.provider.getBalance).toHaveBeenCalledWith(fakeIdentity.wallet.address);
    expect(identityClient.isRegistered).toHaveBeenCalledWith(sellerContract);
    expect(staking.isStakedAboveMin).toHaveBeenCalledWith(sellerContract);
  });

});

describe('checkBuyerReadiness', () => {
  it('all checks pass when buyer has gas and balance', async () => {
    const deposits = mockDepositsClient();

    const checks = await checkBuyerReadiness(fakeIdentity, deposits);

    expect(checks).toHaveLength(2);
    expect(checks.every(c => c.passed)).toBe(true);
  });

  it('fails gas check when ETH balance is zero', async () => {
    const deposits = mockDepositsClient({ ethBalance: 0n });

    const checks = await checkBuyerReadiness(fakeIdentity, deposits);

    const gasCheck = checks.find(c => c.name === 'Gas balance')!;
    expect(gasCheck.passed).toBe(false);
    expect(gasCheck.message).toContain('No ETH for gas');
  });

  it('fails deposit balance check when no USDC available', async () => {
    const deposits = mockDepositsClient({ buyerAvailable: 0n });

    const checks = await checkBuyerReadiness(fakeIdentity, deposits);

    const balCheck = checks.find(c => c.name === 'Deposit balance')!;
    expect(balCheck.passed).toBe(false);
    expect(balCheck.command).toBe('antseed buyer deposit 10');
  });
});

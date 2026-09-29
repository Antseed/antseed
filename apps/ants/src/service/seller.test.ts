import { describe, expect, it, vi } from 'vitest';
import type { AntsContext } from './context.js';
import { registerBinding, seller } from './seller.js';

const address = '0x0000000000000000000000000000000000000001';
const zero = '0x0000000000000000000000000000000000000000';

function fixture() {
  const identity = {
    isRegistered: vi.fn(async () => true),
    getAgentWallet: vi.fn(async () => address),
    register: vi.fn(async () => 77),
  };
  const registry = {
    getAgentId: vi.fn(async () => 42),
    agentSeller: vi.fn(async () => zero),
    isStakedAboveMin: vi.fn(async () => true),
    legacyStakeEligibilityEnabled: async () => true,
    minSellerPoolStake: async () => 1n,
    registerSellerBinding: vi.fn(async (_signer, _agentId, report) => { await report('0xhash'); return true; }),
  };
  const ctx = {
    address, identity: () => identity, sellerRegistry: () => registry,
    stack: async () => ({ phase: 'active', currentEpoch: 22 }),
    legacyStakingAt: () => null, pools: () => null, positionInit: () => null,
    requireSigner: () => ({}), invalidate: vi.fn(),
  } as unknown as AntsContext;
  return { ctx, identity, registry };
}

describe('seller registration', () => {
  it('does not mistake a legacy fallback for an explicit binding', async () => {
    const { ctx, registry } = fixture();
    expect(await seller(ctx)).toMatchObject({ agentId: 42, registryBound: false, eligible: true });
    registry.agentSeller.mockResolvedValue(address);
    expect((await seller(ctx)).registryBound).toBe(true);
  });

  it('fails a read rather than returning false eligibility on an RPC failure', async () => {
    const { ctx, registry } = fixture();
    registry.isStakedAboveMin.mockRejectedValue(new Error('rate limiting'));
    await expect(seller(ctx)).rejects.toThrow('rate limiting');
  });

  it('creates an identity and binds it for a new wallet', async () => {
    const { ctx, identity, registry } = fixture();
    registry.getAgentId.mockResolvedValue(0);
    identity.isRegistered.mockResolvedValue(false);
    const report = vi.fn();
    expect(await registerBinding(ctx, undefined, report)).toEqual({ agentId: 77, sent: true });
    expect(identity.register).toHaveBeenCalledTimes(1);
    expect(registry.registerSellerBinding).toHaveBeenCalledWith({}, 77, expect.any(Function));
    expect(report).toHaveBeenCalledWith(expect.stringContaining('agent 77'));
  });

  it('reuses a known ID without creating another identity', async () => {
    const { ctx, identity } = fixture();
    expect((await registerBinding(ctx)).agentId).toBe(42);
    expect(identity.register).not.toHaveBeenCalled();
  });

  it('requires an ID if an existing unbound identity cannot be discovered', async () => {
    const { ctx, identity, registry } = fixture();
    registry.getAgentId.mockResolvedValue(0);
    await expect(registerBinding(ctx)).rejects.toThrow('already owns an identity');
    expect(identity.register).not.toHaveBeenCalled();
    expect(registry.registerSellerBinding).not.toHaveBeenCalled();
  });

  it('rejects an explicit foreign ID and invalid IDs without minting', async () => {
    const { ctx, identity, registry } = fixture();
    identity.getAgentWallet.mockResolvedValue(zero);
    await expect(registerBinding(ctx, 99)).rejects.toThrow('not this wallet');
    await expect(registerBinding(ctx, 0)).rejects.toThrow('positive integer');
    expect(identity.register).not.toHaveBeenCalled();
    expect(registry.registerSellerBinding).not.toHaveBeenCalled();
  });

  it('records a created ID if binding fails and supports an explicit retry', async () => {
    const { ctx, identity, registry } = fixture();
    registry.getAgentId.mockResolvedValue(0);
    identity.isRegistered.mockResolvedValue(false);
    registry.registerSellerBinding.mockRejectedValueOnce(new Error('binding failed'));
    const report = vi.fn();
    await expect(registerBinding(ctx, undefined, report)).rejects.toThrow('binding failed');
    expect(report).toHaveBeenCalledWith(expect.stringContaining('agent 77'));
    identity.isRegistered.mockResolvedValue(true);
    expect((await registerBinding(ctx, 77)).agentId).toBe(77);
    expect(identity.register).toHaveBeenCalledTimes(1);
  });
});

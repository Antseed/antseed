import { describe, expect, it, vi } from 'vitest';
import { AntsContext, type AntsChainConfig } from './context.js';
import { epochInfo } from './overview.js';

const chain: AntsChainConfig = {
  chainId: 'base-mainnet', evmChainId: 8453, rpcUrl: 'http://127.0.0.1:1',
  registryContractAddress: '0x0000000000000000000000000000000000000001',
  antsTokenAddress: '0x0000000000000000000000000000000000000002',
  emissionsContractAddress: '0x00000000000000000000000000000000000000E2',
  stakingContractAddress: '0x00000000000000000000000000000000000000A1',
  legacyEmissionsContractAddress: '0x00000000000000000000000000000000000000E1',
  usageAccountingAddress: '0x00000000000000000000000000000000000000AA',
  sellerRegistryAddress: '0x00000000000000000000000000000000000000AB',
  emissionsGateAddress: '0x00000000000000000000000000000000000000AC',
};

/** AntsContext with the network-facing clients replaced by fakes. */
class FakeContext extends AntsContext {
  constructor(config: AntsChainConfig, private readonly pointers: { emissions: string; staking: string }, private readonly epoch = 25) {
    super({ chain: config, address: '0x00000000000000000000000000000000000000FF' });
  }
  override registry() { return { emissions: async () => this.pointers.emissions, staking: async () => this.pointers.staking } as never; }
  override gate() {
    if (!this.chain.emissionsGateAddress) return null;
    return { currentEpoch: async () => this.epoch, effectiveEpoch: async () => 22, genesis: async () => 1_775_728_461, epochDuration: async () => 604_800 } as never;
  }
  poolLookupFails = false;
  override legacyEmissionsAt(address: string | null) {
    if (!address) return null;
    return { sellerRewardsPool: async () => { if (this.poolLookupFails) throw new Error('could not decode result data (value="0x", info={ "method": "sellerRewardsPool" }, code=BAD_DATA)'); return '0x00000000000000000000000000000000000000CC'; }, getEpochInfo: async () => ({ epoch: this.epoch, emission: 0n, epochDuration: 604_800 }), getGenesis: async () => 1_775_728_461 } as never;
  }
}

describe('AntsContext.stack', () => {
  it('reports the deployed phase while the registry still points at legacy contracts', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! }, 21);
    const stack = await ctx.stack();
    expect(stack.phase).toBe('deployed');
    expect(stack.legacyEmissions).toBe(chain.emissionsContractAddress);
    expect(stack.legacyStaking).toBe(chain.stakingContractAddress);
    expect(stack.legacyEmissionsV1).toBe(chain.legacyEmissionsContractAddress);
    expect(stack.lockedRewardsPool).toBe('0x00000000000000000000000000000000000000CC');
    expect(await ctx.claimableEpochs()).toEqual({ legacy: Array.from({ length: 21 }, (_, i) => i), recognized: [] });
  });

  it('treats a legacy contract without sellerRewardsPool() as having no locked pool', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! }, 21);
    ctx.poolLookupFails = true;
    const stack = await ctx.stack();
    expect(stack.phase).toBe('deployed');
    expect(stack.lockedRewardsPool).toBeNull();
  });

  it('reports active with a pre-regeneration config (emissions still names V2)', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.usageAccountingAddress!, staking: chain.sellerRegistryAddress! }, 25);
    const stack = await ctx.stack();
    expect(stack.phase).toBe('active');
    expect(stack.legacyEmissions).toBe(chain.emissionsContractAddress);
    expect(stack.legacyStaking).toBe(chain.stakingContractAddress);
    expect(stack.legacyEmissionsV1).toBe(chain.legacyEmissionsContractAddress);
    expect(await ctx.claimableEpochs()).toEqual({ legacy: Array.from({ length: 22 }, (_, i) => i), recognized: [22, 23, 24] });
  });

  it('reports active with a regenerated config (emissions aliases the new stack)', async () => {
    const regenerated: AntsChainConfig = {
      ...chain, emissionsContractAddress: chain.usageAccountingAddress, stakingContractAddress: chain.sellerRegistryAddress,
      legacyEmissionsContractAddress: '0x00000000000000000000000000000000000000E2', legacyStakingContractAddress: '0x00000000000000000000000000000000000000A1',
      legacyEmissionsV1ContractAddress: '0x00000000000000000000000000000000000000E1',
    };
    const stack = await new FakeContext(regenerated, { emissions: chain.usageAccountingAddress!, staking: chain.sellerRegistryAddress! }).stack();
    expect(stack.phase).toBe('active');
    expect(stack.legacyEmissions).toBe('0x00000000000000000000000000000000000000E2');
    expect(stack.legacyStaking).toBe('0x00000000000000000000000000000000000000A1');
    expect(stack.legacyEmissionsV1).toBe('0x00000000000000000000000000000000000000E1');
  });

  it('reports legacy when no recognized-usage contracts are configured', async () => {
    const legacyOnly: AntsChainConfig = { ...chain, usageAccountingAddress: undefined, sellerRegistryAddress: undefined, emissionsGateAddress: undefined };
    const stack = await new FakeContext(legacyOnly, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! }, 9).stack();
    expect(stack.phase).toBe('legacy');
    expect(stack.effectiveEpoch).toBeNull();
    expect(stack.currentEpoch).toBe(9);
  });

  it('caches the resolution until invalidated', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! });
    const first = await ctx.stack();
    expect(await ctx.stack()).toBe(first);
    ctx.invalidate();
    expect(await ctx.stack()).not.toBe(first);
  });

  it('keeps the resolved stack and protocol memos across wallet-only invalidation', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! });
    const first = await ctx.stack();
    ctx.memoSet('eligibility', { stakeable: true }, 60_000);
    ctx.invalidate({ walletOnly: true });
    expect(await ctx.stack()).toBe(first);
    expect(ctx.memoGet('eligibility')).toEqual({ stakeable: true });
    ctx.invalidate();
    expect(ctx.memoGet('eligibility')).toBeUndefined();
  });

  it('invalidates in-flight RPC sharing when the wallet or action state changes', () => {
    const ctx = new AntsContext({ chain, address: '0x0' });
    const provider = ctx.provider();
    const invalidate = vi.spyOn(provider, 'invalidateReads');
    ctx.invalidate();
    expect(invalidate).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it('shares stack resolution across independent simultaneous page loads', async () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! });
    const registry = vi.spyOn(ctx, 'registry');
    const results = await Promise.all([ctx.stack(), ctx.stack(), ctx.stack(), ctx.stack()]);
    expect(registry).toHaveBeenCalledTimes(1);
    expect(results.every(result => result === results[0])).toBe(true);
  });

  it('refuses signing actions without a signer', () => {
    const ctx = new FakeContext(chain, { emissions: chain.emissionsContractAddress!, staking: chain.stakingContractAddress! });
    expect(() => ctx.requireSigner()).toThrow(/Connect a wallet/);
  });
});

describe('epochInfo', () => {
  it('computes the next boundary from genesis and duration', () => {
    const info = epochInfo({ currentEpoch: 21, effectiveEpoch: 22, genesis: 1_775_728_461, epochDuration: 604_800 }, 1_789_000_000);
    expect(info.nextBoundaryAt).toBe(1_775_728_461 + 22 * 604_800);
    expect(info.secondsToBoundary).toBe(info.nextBoundaryAt - 1_789_000_000);
  });
});

describe('AntsContext.selectRpc', () => {
  const withFallbacks = { ...chain, rpcUrl: 'https://primary', fallbackRpcUrls: ['https://second', 'https://third'] };

  it('scores every endpoint and routes reads best-first through one shared provider', async () => {
    const scores: Record<string, number | null> = { 'https://primary': 12.4, 'https://second': 0.3, 'https://third': null };
    const probed: string[] = [];
    const ctx = new AntsContext({ chain: withFallbacks, address: '0x0', probeRpc: async (url) => { probed.push(url); return scores[url] ?? null; } });
    await ctx.selectRpc();
    expect(probed.sort()).toEqual(['https://primary', 'https://second', 'https://third']);
    expect(ctx.chain.rpcUrl).toBe('https://second');
    expect(ctx.chain.fallbackRpcUrls).toEqual(['https://primary', 'https://third']);
    expect(ctx.provider().urls).toEqual(['https://second', 'https://primary', 'https://third']);
    expect(ctx.registry().provider).toBe(ctx.antsToken().provider);
    expect(ctx.registry().provider).toBe(ctx.provider());
  });

  it('keeps the configured list when nothing answers, and probes only once', async () => {
    let probes = 0;
    const ctx = new AntsContext({ chain: withFallbacks, address: '0x0', probeRpc: async () => { probes += 1; return null; } });
    await Promise.all([ctx.selectRpc(), ctx.selectRpc()]);
    await ctx.selectRpc();
    expect(probes).toBe(3);
    expect(ctx.chain.rpcUrl).toBe('https://primary');
    expect(ctx.chain.fallbackRpcUrls).toEqual(['https://second', 'https://third']);
    expect(ctx.provider().urls).toEqual(['https://primary', 'https://second', 'https://third']);
  });

  it('does nothing without fallbacks', async () => {
    let probes = 0;
    const ctx = new AntsContext({ chain: { ...chain, fallbackRpcUrls: [] }, address: '0x0', probeRpc: async () => { probes += 1; return 0; } });
    await ctx.selectRpc();
    expect(probes).toBe(0);
  });
});

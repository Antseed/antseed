import { afterEach, describe, expect, it, vi } from 'vitest';
import { GATE_MINTERS, gateMinterId, multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import { invalidateNetwork, networkSnapshot } from './network.js';

vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
const gate = '0x0000000000000000000000000000000000000001';
const pools = '0x0000000000000000000000000000000000000002';
const staker = '0x0000000000000000000000000000000000000003';
const usage = '0x0000000000000000000000000000000000000004';
const accounting = '0x0000000000000000000000000000000000000005';

function fixture() {
  const block = { number: 123, timestamp: 2550 };
  const provider = { getBlock: vi.fn(async () => ({ ...block })) };
  const ctx = { chain: { chainId: 'base-local', evmChainId: 31337, emissionsGateAddress: gate, sellerPoolsAddress: pools, sellerPoolsRewardsAddress: staker, usageRewardsAddress: usage, usageAccountingAddress: accounting, antsTokenAddress: gate, registryContractAddress: gate, sellerRegistryAddress: pools }, provider: () => provider } as unknown as AntsContext;
  const overrides = new Map<string, unknown[] | null>();
  const answer = (request: MulticallRequest): unknown[] | null => {
    const epoch = Number(request.args?.at(-1));
    if (overrides.has(request.method)) return overrides.get(request.method)!;
    switch (request.method) {
      case 'genesis': return [0n];
      case 'epochDuration': return [100n];
      case 'currentEpoch': return [BigInt(Math.floor(block.timestamp / 100))];
      case 'effectiveEpoch': return [22n];
      case 'INITIAL_EMISSION': case 'initialEmission': return [10000n];
      case 'SHARE_DENOMINATOR': case 'GATE_SHARE_DENOMINATOR': return [100000n];
      case 'HALVING_INTERVAL': return [104n];
      case 'getEpochEmission': return [5000n];
      case 'minters': return [request.args?.[0] === gateMinterId(GATE_MINTERS[0].id) ? staker : usage, 99000n, true];
      case 'minterEpochBudget': return [epoch === 25 ? 2000n : 1500n];
      case 'emissionsGate': return [gate];
      case 'sellerPools': return [pools];
      case 'usageAccounting': return [accounting];
      case 'emissions': return [accounting];
      case 'staking': return [pools];
      case 'stakerEpochBudget': return [101n];
      case 'usageEpochBudgets': return [60n, 40n];
      case 'dynamicStakerConfigAt': return [[2000n, 40000n, 400000000n]];
      case 'dynamicUsageConfigAt': return [[5000n, 10000n, 5000n, 10000n, epoch === 25 ? 1000000n : 2000000n]];
      case 'totalBuyerPointsByEpoch': return [100n];
      case 'totalSellerPointsByEpoch': return [150n];
      default: return [1000n];
    }
  };
  vi.mocked(multicallRead).mockReset();
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(answer));
  return { ctx, provider, block, overrides };
}

afterEach(() => vi.useRealTimers());

describe('block-pinned network snapshot', () => {
  it('uses two cold batches at one block, with no legacy or per-bucket RPC calls', async () => {
    const { ctx, provider } = fixture();
    const view = await networkSnapshot(ctx);
    expect(provider.getBlock).toHaveBeenCalledOnce();
    expect(multicallRead).toHaveBeenCalledTimes(2);
    for (const call of vi.mocked(multicallRead).mock.calls) expect(call[2]).toEqual({ blockTag: 123 });
    expect(view).toMatchObject({ blockNumber: 123, epoch: { current: 25 }, budgets: { staker: '101', buyer: '60', seller: '40' }, scaledStakeTarget: '200000000', usageVolume: '150', errors: [] });
    expect(view.buckets[0]).toMatchObject({ budget: '2000', nextBudget: '1500' });
    expect(view.usageConfig?.volumeShareTarget).toBe('1000000');
    expect(view.nextUsageConfig?.volumeShareTarget).toBe('2000000');
  });

  it('deduplicates concurrent requests, caches results, and keeps metadata across invalidation', async () => {
    const { ctx, provider } = fixture();
    const [first, second] = await Promise.all([networkSnapshot(ctx), networkSnapshot(ctx)]);
    expect(first).toBe(second);
    expect(await networkSnapshot(ctx)).toBe(first);
    expect(provider.getBlock).toHaveBeenCalledOnce();
    invalidateNetwork(ctx);
    await networkSnapshot(ctx);
    expect(multicallRead).toHaveBeenCalledTimes(3);
    expect(provider.getBlock).toHaveBeenCalledTimes(2);
  });

  it('refreshes epoch-specific budgets at a boundary even within the cache TTL', async () => {
    vi.useFakeTimers();
    const { ctx, block } = fixture();
    block.timestamp = 2599;
    expect((await networkSnapshot(ctx)).epoch.current).toBe(25);
    block.timestamp = 2600;
    block.number++;
    vi.setSystemTime(Date.now() + 1001);
    const next = await networkSnapshot(ctx);
    expect(next.epoch.current).toBe(26);
    expect(vi.mocked(multicallRead).mock.calls.at(-1)?.[2]).toEqual({ blockTag: 124 });
  });

  it('expires live data after twenty seconds without refetching immutable configuration', async () => {
    vi.useFakeTimers();
    const { ctx } = fixture();
    await networkSnapshot(ctx);
    vi.setSystemTime(Date.now() + 20_001);
    await networkSnapshot(ctx);
    expect(multicallRead).toHaveBeenCalledTimes(3);
  });

  it('retains unavailable fields as null instead of false zero values', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('usageEpochBudgets', null);
    overrides.set('totalSupply', null);
    const view = await networkSnapshot(ctx);
    expect(view.budgets.buyer).toBeNull();
    expect(view.totalSupply).toBeNull();
    expect(view.errors).toContain('Usage budgets unavailable.');
    expect(view.errors).toContain('Token supply unavailable.');
  });

  it('does not trust budgets from mismatched configured controllers', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('emissionsGate', [pools]);
    const view = await networkSnapshot(ctx);
    expect(view.budgets).toEqual({ staker: null, buyer: null, seller: null });
    expect(view.errors.join(' ')).toContain('could not be verified');
  });

  it('keeps contract-returned frozen or capped budgets rather than recomputing from inputs', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('totalActiveStakeAtEpoch', [0n]);
    overrides.set('totalBuyerPointsByEpoch', [0n]);
    overrides.set('totalSellerPointsByEpoch', [0n]);
    overrides.set('stakerEpochBudget', [2000n]);
    overrides.set('usageEpochBudgets', [1200n, 800n]);
    const view = await networkSnapshot(ctx);
    expect(view.budgets).toEqual({ staker: '2000', buyer: '1200', seller: '800' });
  });

  it('preserves genuine zero budgets and scales the stake target at zero emission', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('getEpochEmission', [0n]);
    overrides.set('stakerEpochBudget', [0n]);
    overrides.set('usageEpochBudgets', [0n, 0n]);
    const view = await networkSnapshot(ctx);
    expect(view.budgets).toEqual({ staker: '0', buyer: '0', seller: '0' });
    expect(view.scaledStakeTarget).toBe('0');
  });

  it('rejects inconsistent block/epoch data and permits a clean retry', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('currentEpoch', [26n]);
    await expect(networkSnapshot(ctx)).rejects.toThrow('does not match');
    overrides.delete('currentEpoch');
    expect((await networkSnapshot(ctx)).epoch.current).toBe(25);
  });

  it('separates caches when deployment addresses change', async () => {
    const { ctx } = fixture();
    await networkSnapshot(ctx);
    ctx.chain = { ...ctx.chain, emissionsGateAddress: pools };
    await networkSnapshot(ctx);
    expect(multicallRead).toHaveBeenCalledTimes(4);
  });

  it('does not advertise a configured stack as active before registry activation', async () => {
    const { ctx, overrides } = fixture();
    overrides.set('emissions', [gate]);
    expect((await networkSnapshot(ctx)).activation).toBe('not-active');
  });

  it('does not let an invalidated in-flight read repopulate the cache', async () => {
    const { ctx, provider } = fixture();
    let release!: (block: { number: number; timestamp: number }) => void;
    provider.getBlock.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const old = networkSnapshot(ctx);
    invalidateNetwork(ctx);
    const fresh = await networkSnapshot(ctx);
    release({ number: 122, timestamp: 2550 });
    await old;
    expect(await networkSnapshot(ctx)).toBe(fresh);
    expect(fresh.blockNumber).toBe(123);
  });
});

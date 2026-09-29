import { describe, expect, it, vi } from 'vitest';
import { ZeroAddress } from 'ethers';
import { multicallRead } from '@antseed/node/payments';
import { poolsView, singlePool } from './pools.js';
import { poolYield } from './yield.js';
import { explorerSellers } from './explorer.js';
import type { AntsContext } from './context.js';
import type { IndexedPools, IndexedSellerEpoch } from './indexer.js';
vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
vi.mock('./explorer.js', () => ({ explorerSellers: vi.fn() }));

function setup(indexedEpoch = 2, historical = true, currentEpoch = 2) {
  const address = '0x0000000000000000000000000000000000000001';
  const network = (epoch: number) => ({ epoch, complete: true, totalPowerWeight: '100', totalActiveStake: '10', stakerBudget: '5', totalWeightedPoolPoints: '10' });
  const indexed = {
    currentEpoch: indexedEpoch, network: { current: network(indexedEpoch), last: network(indexedEpoch - 1) },
    pools: [{ agentId: 1, seller: address, registered: true, openPositions: 1, weight: '100', activeStake: '10', powerShareBps: 10000, securityShareBps: '0', usagePoints: '10', weightedUsagePoints: '10', lastUsagePoints: '10', lastEmission: '5', lastEmissionSettled: true, lastWeight: '90', volumeUsdc: '1', lastVolumeUsdc: '1', historicalYield: historical ? { power: '90', reward: '5', settled: true } : null }],
  } as IndexedPools;
  const indexer = { pools: vi.fn(async () => indexed), pool: vi.fn(), sellerEpochs: vi.fn(async () => new Map<string, IndexedSellerEpoch[]>()), epochMetrics: async () => [] };
  const live = vi.fn(async () => 100n);
  const explorer = { byAddress: new Map(), byAgent: new Map<number, string>() };
  vi.mocked(explorerSellers).mockResolvedValue(explorer);
  const ineligible = new Set<number>();
  const ctx = {
    address: ZeroAddress,
    chain: { sellerPoolsAddress: address, sellerPoolsRewardsAddress: address, usageAccountingAddress: address },
    stack: async () => ({ currentEpoch, effectiveEpoch: 0, epochDuration: 604800, genesis: 0 }),
    indexer: () => indexer,
    requirePools: () => ({ contractAddress: address, provider: { getBlockNumber: async () => 123 }, totalPowerWeightAtEpoch: live }),
    poolRewards: () => ({ stakerEpochBudget: live }),
    usageAccounting: () => ({ totalWeightedPoolPointsByEpoch: live }),
  } as unknown as AntsContext;
  const methods: string[] = [];
  vi.mocked(multicallRead).mockImplementation(async (_provider, requests) => requests.map(r => {
    methods.push(r.method);
    if (r.method === 'identityRegistry' || r.method === 'stakingSource') return [address];
    if (r.method === 'ownerOf') return [`0x${(1000n + BigInt(r.args![0] as number)).toString(16).padStart(40, '0')}`];
    if (r.method === 'getAgentId') {
      const agentId = Number(BigInt(r.args![0] as string) - 1000n);
      return [ineligible.has(agentId) ? 0n : BigInt(agentId)];
    }
    if (r.method === 'poolEpochEmissions') return [true, 7n];
    if (r.method === 'agentEpochUsage') return [{ weightedPoints: 1n }];
    if (r.method === 'minStakeEpochs') return [1n];
    if (r.method === 'MAX_STAKE_EPOCHS') return [104n];
    return [100n];
  }));
  return { ctx, indexer, indexed, live, methods, explorer, ineligible };
}

describe('pool loading', () => {
  it('allows legacy providers even when the indexer reports them unregistered, without hiding their yield', async () => {
    const { ctx, indexed, methods } = setup();
    indexed.pools[0]!.registered = false;
    const list = await poolsView(ctx);
    const detail = await singlePool(ctx, 1);
    expect(list.pools[0]).toMatchObject({ stakeable: true, hasPool: true, yield: { status: 'settled', reward: '5' } });
    expect(detail.stakeable).toBe(true);
    expect(detail.yield).toEqual(list.pools[0]!.yield);
    expect(methods).not.toContain('agentSeller');
  });

  it('allows the first stake into registered directory providers missing from the pool index', async () => {
    const { ctx, explorer } = setup();
    explorer.byAgent.set(2, '0x0000000000000000000000000000000000000002');
    const list = await poolsView(ctx);
    const provider = list.pools.find(pool => pool.agentId === 2)!;
    expect(provider).toMatchObject({ stakeable: true, hasPool: false });
    expect(provider.yield).toBeUndefined();
    const detail = await singlePool(ctx, 2);
    expect(detail.stakeable).toBe(true);
    expect(detail.yield).toBeUndefined();
  });

  it('overrides stale indexed eligibility and sorts newly eligible providers first', async () => {
    const { ctx, explorer, ineligible } = setup();
    ineligible.add(1);
    explorer.byAgent.set(2, '0x0000000000000000000000000000000000000002');
    const list = await poolsView(ctx);
    expect(list.pools.map(pool => [pool.agentId, pool.stakeable])).toEqual([[2, true], [1, false]]);
  });

  it('uses the same legacy-compatible check for live pool fallback', async () => {
    const { ctx, methods } = setup();
    Object.assign(ctx, { indexer: () => null });
    expect(await singlePool(ctx, 1)).toMatchObject({ agentId: 1, stakeable: true });
    expect(methods).not.toContain('agentSeller');
  });

  it('uses matching indexed global/history data without per-seller detail requests or disconnected-wallet scans', async () => {
    const { ctx, indexer, live, methods } = setup();
    const result = await poolsView(ctx);
    expect(indexer.pool).not.toHaveBeenCalled();
    expect(live).not.toHaveBeenCalled();
    expect(methods).not.toContain('poolWeightAtEpoch');
    expect(methods).not.toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield).toEqual({ ...poolYield(5n, 100n, 1, 604800, 0, true), reward: '5', power: '90', minLockEpochs: 1, maxLockEpochs: 104 });
    expect(result.pools[0]?.activeStake).toBe('10');
  });
  it('does not read historical contracts for directory entries with no staking pool', async () => {
    const { ctx, indexed, methods } = setup();
    indexed.pools.push({ ...indexed.pools[0]!, agentId: 2, openPositions: 0, weight: '0', activeStake: '0', historicalYield: null });
    const result = await poolsView(ctx);
    expect(result.pools.find(p => p.agentId === 2)?.yield).toBeUndefined();
    expect(methods.filter(method => method === 'poolActiveStakeAtEpoch')).toHaveLength(1);
  });

  it('falls back to chain inputs when the indexer is on another epoch', async () => {
    const { ctx, live, methods } = setup(1);
    const result = await poolsView(ctx);
    expect(live).toHaveBeenCalled();
    expect(methods).toContain('poolWeightAtEpoch');
    expect(methods).toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield).toEqual({ ...poolYield(7n, 100n, 1, 604800, 0, true), reward: '7', power: '100', minLockEpochs: 1, maxLockEpochs: 104 });
    expect(result.pools[0]?.volumeStatus).toBe('stale');
  });
  it('does not interpret missing historical fields as a zero-yield epoch', async () => {
    const { ctx, methods } = setup(2, false);
    const result = await poolsView(ctx);
    expect(methods).toContain('poolEpochEmissions');
    expect(result.pools[0]?.yield).toEqual({ ...poolYield(7n, 100n, 1, 604800, 0, true), reward: '7', power: '100', minLockEpochs: 1, maxLockEpochs: 104 });
  });

  it('keeps legacy seller epochs and amounts unchanged when pool details load', async () => {
    const { ctx, indexer, indexed } = setup(23, true, 23);
    const seller = indexed.pools[0]!.seller!;
    const volumes = ['21419582', '4262829', '21427226', '9678385', '3454778', '682288', '5029021', '1263910', '670601'];
    indexer.sellerEpochs.mockResolvedValue(new Map([[seller, volumes.map((volumeUsdc, index) => ({
      seller, epoch: 23 - index, agentId: index < 2 ? 1 : null, volumeUsdc, points: '0', weightedPoints: '0', requests: '1',
    }))]]));
    indexer.pool.mockResolvedValue({ epochs: [
      { epoch: 24, volumeUsdc: '0' }, { epoch: 23, volumeUsdc: volumes[0] },
      { epoch: 22, volumeUsdc: volumes[1] }, { epoch: 21, volumeUsdc: '0' },
    ] });
    const summary = (await poolsView(ctx)).pools[0]!;
    const detail = await singlePool(ctx, 1);
    expect(detail.volumes).toEqual(summary.volumes);
    expect(detail.volumes.filter(row => row.epoch < detail.currentEpoch)).toHaveLength(8);
    expect(detail.volumes.find(row => row.epoch === 21)?.usdc).toBe('21427226');
    expect(detail.volumes.map(row => row.epoch)).toEqual([23, 22, 21, 20, 19, 18, 17, 16, 15]);
    expect(detail.volumeStatus).toBe('available');
    expect(detail.yield).toEqual(summary.yield);
    expect(indexer.pool).not.toHaveBeenCalled();
    expect(indexer.sellerEpochs).toHaveBeenCalledWith(9);
  });

  it('marks stale history consistently in the list and detail without relabelling older epochs', async () => {
    const { ctx, indexed, indexer } = setup(22, true, 23);
    const seller = indexed.pools[0]!.seller!;
    indexer.sellerEpochs.mockResolvedValue(new Map([[seller, [{ seller, epoch: 22, agentId: 1, volumeUsdc: '42', points: '0', weightedPoints: '0', requests: '1' }]]]));
    indexer.pool.mockResolvedValue({ epochs: [{ epoch: 22, volumeUsdc: '42' }] });
    for (const pool of [(await poolsView(ctx)).pools[0]!, await singlePool(ctx, 1)]) {
      expect(pool.volumes).toEqual([]);
      expect(pool.volumeStatus).toBe('stale');
    }
  });

  it.each([false, true])('keeps unknown seller history distinct from an explicit zero (reported: %s)', async (reported) => {
    const { ctx, indexed, indexer } = setup(23, true, 23);
    indexed.pools[0]!.volumeAvailable = false;
    indexed.pools[0]!.lastVolumeAvailable = false;
    const seller = indexed.pools[0]!.seller!;
    if (reported) indexer.sellerEpochs.mockResolvedValue(new Map([[seller, [{ seller, epoch: 21, agentId: null, volumeUsdc: '0', points: '0', weightedPoints: '0', requests: '0' }]]]));
    indexer.pool.mockResolvedValue({ epochs: [] });
    for (const pool of [(await poolsView(ctx)).pools[0]!, await singlePool(ctx, 1)]) {
      expect(pool.volumes).toEqual(reported ? [{ epoch: 21, usdc: '0' }] : []);
      expect(pool.volumeStatus).toBe(reported ? 'available' : 'unavailable');
    }
  });
});

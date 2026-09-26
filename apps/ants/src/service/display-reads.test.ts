import { beforeEach, describe, expect, it, vi } from 'vitest';
import { multicallRead, type MulticallRequest } from '@antseed/node/payments';
import type { AntsContext } from './context.js';
import type { RewardPositions } from './position-feed.js';
import type { DisplaySnapshot } from './display-snapshot.js';
import { IndexerError, type IndexedPools } from './indexer.js';
import { overviewReads } from './overview-reads.js';
import { networkSnapshot } from './network.js';
import type { NetworkSnapshot } from '../api-types.js';
import { positions, move } from './positions.js';
import { poolsView, singlePool } from './pools.js';
import { poolYield } from './yield.js';

vi.mock('@antseed/node/payments', async original => ({ ...await original<object>(), multicallRead: vi.fn() }));
vi.mock('./network.js', () => ({ networkSnapshot: vi.fn() }));
vi.mock('./explorer.js', () => ({ explorerSellers: async () => ({ byAddress: new Map(), byAgent: new Map() }) }));
vi.mock('./stake-eligibility.js', () => ({ stakeEligibility: async (_ctx: unknown, ids: number[]) => new Map(ids.map(id => [id, { owner, stakeable: true }])) }));
const owner = '0x0000000000000000000000000000000000000001';

function fixture() {
  const now = Math.floor(Date.now() / 1000);
  const stack = { currentEpoch: 22, effectiveEpoch: 0, genesis: now - 22 * 604800 - 100, epochDuration: 604800, legacyStaking: owner };
  const epoch = (value: number) => ({ epoch: value, totalActiveStake: '1000', totalPowerWeight: '2000', totalSellerPoints: '10', totalWeightedPoolPoints: '20', totalBuyerPoints: '10', volumeUsdc: '0', requests: '0', stakerBudget: '100', complete: true });
  const snapshot: DisplaySnapshot = {
    chainId: 8453, indexedBlock: 100, indexedAt: now, epochs: [epoch(22), epoch(21)],
    pools: [22, 21].map(epoch => ({ agentId: 1, epoch, weight: '200', activeStake: '100', usagePoints: '3', weightedUsagePoints: '4', settledEmission: '10', settled: true, snapshotBlock: 90, lastBlockNumber: 99 })),
  };
  const indexed = {
    currentEpoch: 22, network: { current: epoch(22), last: epoch(21) },
    pools: [{ agentId: 1, seller: owner, registered: true, openPositions: 1, totalPositions: 2, weight: '200', activeStake: '100', powerShareBps: 1000, securityShareBps: '0', usagePoints: '3', weightedUsagePoints: '4', lastUsagePoints: '3', lastEmission: '10', lastEmissionSettled: true, lastWeight: '200', volumeUsdc: '0', lastVolumeUsdc: '0' }],
  } as IndexedPools;
  const feed: RewardPositions = {
    currentEpoch: 22, positions: [{ id: 7, owner, agentId: 1, amount: '100', weightAmount: '200', stakeStartEpoch: 1, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false, maxLocked: true, restaked: false, closedBy: null, replacementIds: [], sourceId: null, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: null,
      state: 'active', power: '200', nextPower: '200', withdrawableEpoch: 1, maxLockedNext: true, changePending: false,
      rewards: { status: 'available', pending: '15', claimedThroughEpoch: 1, calculatedThroughEpoch: 21, requiresPoolIndexing: false } }],
    summary: [{ agentId: 1, positionIds: [7], activeStake: '100', pendingStake: '0', power: '200' }], totals: { activeStake: '100', pendingStake: '0', power: '200' },
    liveSource: { currentEpoch: 22, fetchedAt: now, stale: false, complete: true },
    source: { schemaVersion: 1, chainId: 8453, contracts: { sellerPools: owner, sellerPoolsRewards: owner }, indexedBlock: 100, indexedBlockHash: `0x${'ab'.repeat(32)}`, indexedAt: now, revision: 'revision', stale: false, complete: true, historyComplete: true, historyFromBlock: 1 },
  };
  const indexer = {
    rewardPositions: vi.fn(async () => feed),
    displaySnapshot: vi.fn(async () => snapshot), pools: vi.fn(async () => indexed),
    pool: vi.fn(async () => ({ stakers: 2, openPositions: 3 })),
    positions: vi.fn(async () => []), sellerEpochs: async () => new Map(), epochMetrics: async () => [],
  };
  const livePosition = (id: number) => ({ id, owner, agentId: 1, amount: 100n, weightAmount: 200n, stakeStartEpoch: 1, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false });
  const provider = { getBalance: vi.fn(async () => 9n), getBlockNumber: async () => 101 };
  const pools = {
    contractAddress: owner, provider,
    poolConfig: async () => ({ minStakeEpochs: 1, maxStakeEpochs: 104, maxSlashBps: 9000, minEarlyExitSlashBps: 0 }),
    allStakerPositionIds: vi.fn(async () => [7]), positionsBatch: vi.fn(async (ids: number[]) => ids.map(livePosition)),
    positionStatusesBatch: vi.fn(async () => [{ withdrawableEpoch: 1, maxLocked: false, slashBps: 1000 }]),
    totalPowerWeightAtEpoch: vi.fn(async () => 2000n), totalActiveStakeAtEpoch: vi.fn(async () => 1000n),
    moveStake: vi.fn(),
  };
  const rewards = { previewStakerRewards: vi.fn(async (ids: number[]) => ids.map(() => 15n)), stakerEpochBudget: vi.fn(async () => 100n) };
  const accounting = { totalWeightedPoolPointsByEpoch: vi.fn(async () => 20n) };
  const ctx = {
    address: owner, chain: { evmChainId: 8453, sellerPoolsAddress: owner, sellerPoolsRewardsAddress: owner, usageAccountingAddress: owner, sellerRegistryAddress: owner, emissionsGateAddress: owner, usageRewardsAddress: owner },
    stack: async () => stack, indexer: () => indexer, requirePools: () => pools, poolRewards: () => rewards,
    usageAccounting: () => accounting, provider: () => provider, antsToken: () => ({ contractAddress: owner }),
    localPositionIds: new Map<number, string>(), requireSigner: () => ({}),
  } as unknown as AntsContext;
  const requests: MulticallRequest[] = [];
  vi.mocked(multicallRead).mockImplementation(async (_provider, calls) => {
    requests.push(...calls);
    return calls.map(call => {
      if (call.method === 'positionWithdrawableEpoch' || call.method === 'minStakeEpochs') return [1n];
      if (call.method === 'earlyExitSlashBps') return [1000n];
      if (call.method === 'MAX_STAKE_EPOCHS') return [104n];
      if (call.method === 'usageEpochBudgets') return [7n, 8n];
      if (call.method === 'transfersEnabled' || call.method === 'transferWhitelist') return [true];
      return [100n];
    });
  });
  return { ctx, stack, snapshot, indexer, pools, rewards, accounting, requests, livePosition, feed };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(networkSnapshot).mockResolvedValue({ totalSupply: '100', maxSupply: '100', totalActiveStake: '1000', totalPowerWeight: '2000', emission: '100', budgets: { staker: '100', buyer: '7', seller: '8' }, errors: [] } as unknown as NetworkSnapshot);
});

describe('indexed display / live financial read boundary', () => {
  function positionFeeds() {
    const result = fixture();
    return { ...result, live: result.feed, reward: result.feed, feeds: result.indexer };
  }

  it('uses PR8 rewards and PR9 live fields without per-position RPC display reads', async () => {
    const { ctx, pools, rewards, requests, feeds } = positionFeeds();
    const result = await positions(ctx);
    expect(result.positions[0]).toMatchObject({ id: 7, pendingReward: '15', power: '200', nextPower: '200', maxLockedNext: true, changePending: false, slashBps: null });
    expect(result.totals).toEqual({ activeStake: '100', pendingStake: '0', pendingRewards: '15', open: 1 });
    expect(result.rewardSource).toMatchObject({ indexedBlock: 100 });
    expect(feeds.rewardPositions).toHaveBeenCalledOnce();
    expect(feeds.rewardPositions).toHaveBeenCalledWith(owner);
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.positionStatusesBatch).not.toHaveBeenCalled();
    expect(rewards.previewStakerRewards).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('preserves live positions when indexed rewards are incomplete', async () => {
    const { ctx, reward, rewards } = positionFeeds();
    reward.source.historyComplete = false;
    const result = await positions(ctx);
    expect(result.positions[0]!.pendingReward).toBeNull();
    expect(result.totals.pendingRewards).toBeNull();
    expect(result.rewardSource?.error).toContain('incomplete');
    expect(rewards.previewStakerRewards).not.toHaveBeenCalled();
  });

  it('does not treat an unavailable reward row as zero', async () => {
    const { ctx, reward } = positionFeeds();
    reward.positions[0]!.rewards.status = 'unavailable';
    const result = await positions(ctx);
    expect(result.totals.pendingRewards).toBeNull();
    expect(result.rewardSource?.error).toContain('unavailable');
  });

  it('rejects stale live state without per-position RPC fallback', async () => {
    const { ctx, live, pools, requests, rewards } = positionFeeds();
    live.liveSource.stale = true;
    await expect(positions(ctx)).rejects.toThrow('stale');
    await expect(poolsView(ctx)).rejects.toThrow('stale');
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    expect(rewards.previewStakerRewards).not.toHaveBeenCalled();
  });

  it('uses whole-wallet live summaries for personal pool totals', async () => {
    const { ctx, pools, requests } = positionFeeds();
    const result = await poolsView(ctx);
    expect(result).toMatchObject({ yourPendingStake: '0', yourTotalPower: '200' });
    expect(result.pools[0]).toMatchObject({ yourStake: '100', yourPower: '200' });
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(requests.map(row => row.method)).not.toContain('positionWeightAtEpoch');
  });

  it('waits for Antscan after a confirmed transaction without querying fallback records', async () => {
    const { ctx, pools } = positionFeeds();
    Object.assign(ctx, { positionReadBarriers: new Map([[owner, { block: 101, at: Math.floor(Date.now() / 1000) }]]) });
    await expect(positions(ctx)).rejects.toMatchObject({ name: 'IndexerSyncingError' });
    const pending = await poolsView(ctx);
    expect(pending).toMatchObject({ walletSyncing: true, yourTotalPower: '0', yourPendingStake: '0' });
    expect(pending.pools.every(pool => pool.yourStake === '0' && pool.yourPositionIds.length === 0)).toBe(true);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.positionsBatch).not.toHaveBeenCalled();
    expect(pools.positionStatusesBatch).not.toHaveBeenCalled();
  });

  it('shares the coherent live network snapshot while keeping wallet state and permissions live', async () => {
    const { ctx, stack, requests } = fixture();
    const result = await overviewReads(ctx, stack);
    expect(result).toMatchObject({ networkAvailable: true, networkStake: 1000n, networkWeight: 2000n, stakerBudget: 100n, ants: 100n, eth: 9n, networkSource: { source: 'chain' } });
    expect(requests).toHaveLength(7);
    expect(requests.map(row => row.method)).toEqual(expect.arrayContaining(['balanceOf', 'transferWhitelist', 'stakerTotalActiveStake', 'stakerPositionCount']));
    expect(requests.map(row => row.method)).not.toEqual(expect.arrayContaining(['totalActiveStakeAtEpoch', 'totalPowerWeightAtEpoch', 'stakerEpochBudget']));
  });

  it('does not replace a failed live snapshot with mixed indexed statistics', async () => {
    const { ctx, stack, indexer, requests } = fixture();
    vi.mocked(networkSnapshot).mockRejectedValueOnce(new Error('Snapshot unavailable'));
    const result = await overviewReads(ctx, stack);
    expect(result.networkSource).toMatchObject({ source: 'chain', error: 'Snapshot unavailable' });
    expect(result.networkAvailable).toBe(false);
    expect(indexer.displaySnapshot).not.toHaveBeenCalled();
    expect(requests).toHaveLength(7);
  });

  it('retains direct reads when the indexer is explicitly unconfigured', async () => {
    const { ctx, pools, rewards } = fixture();
    ctx.indexer = () => null;
    const result = await positions(ctx);
    expect(pools.allStakerPositionIds).toHaveBeenCalledOnce();
    expect(pools.positionsBatch).toHaveBeenCalledWith([7]);
    expect(pools.positionStatusesBatch).toHaveBeenCalledOnce();
    expect(rewards.previewStakerRewards).toHaveBeenCalledWith([7]);
    expect(result.displaySource).toEqual({ source: 'chain' });
    expect(result.positions[0]).toMatchObject({ id: 7, pendingReward: '15', slashBps: 1000 });
  });

  it('does not enumerate or preview rewards for an indexed empty wallet', async () => {
    const { ctx, feed, pools, rewards, requests } = fixture();
    feed.positions = [];
    feed.summary = [];
    feed.totals = { activeStake: '0', pendingStake: '0', power: '0' };
    expect((await positions(ctx)).positions).toEqual([]);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(rewards.previewStakerRewards).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
  });

  it('keeps empty-wallet rewards unknown when snapshot coverage is incomplete', async () => {
    const { ctx, feed } = fixture();
    feed.positions = [];
    feed.source.historyComplete = false;
    const result = await positions(ctx);
    expect(result.positions).toEqual([]);
    expect(result.totals.pendingRewards).toBeNull();
    expect(result.rewardSource?.error).toContain('incomplete');
  });

  it('does not overlay local positions with a second RPC display implementation', async () => {
    const { ctx, feed, pools } = fixture();
    ctx.localPositionIds.set(7, owner);
    feed.positions[0]!.closedBy = 'move';
    feed.positions[0]!.closedAtEpoch = 23;
    feed.positions[0]!.replacementIds = [8];
    const result = await positions(ctx);
    expect(result.positions[0]).toMatchObject({ id: 7, closedBy: 'move', closedAtEpoch: 23, replacementIds: [8] });
    expect(pools.positionsBatch).not.toHaveBeenCalled();
  });

  it('does not restore locally remembered positions absent from the current wallet feed', async () => {
    const { ctx, feed, pools } = fixture();
    ctx.localPositionIds.set(7, owner);
    feed.positions = [];
    feed.summary = [];
    feed.totals = { activeStake: '0', pendingStake: '0', power: '0' };
    expect((await positions(ctx)).positions).toEqual([]);
    expect(pools.positionsBatch).not.toHaveBeenCalled();
  });

  it('surfaces Antscan failure without RPC fan-out', async () => {
    const { ctx, pools, indexer } = fixture();
    indexer.rewardPositions.mockRejectedValue(new IndexerError('offline', 'https://scan/api'));
    await expect(positions(ctx)).rejects.toThrow('offline');
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.positionStatusesBatch).not.toHaveBeenCalled();
  });

  it('never treats failed direct reads as zero when there is no indexer', async () => {
    const { ctx, rewards, pools } = fixture();
    ctx.indexer = () => null;
    rewards.previewStakerRewards.mockRejectedValueOnce(new Error('RPC reward failure'));
    await expect(positions(ctx)).rejects.toThrow('RPC reward failure');
    pools.positionStatusesBatch.mockRejectedValueOnce(new Error('RPC status failure'));
    await expect(positions(ctx)).rejects.toThrow('RPC status failure');
  });

  it('verifies ownership on chain before writes, regardless of indexed ownership', async () => {
    const { ctx, pools, indexer, livePosition } = fixture();
    pools.positionsBatch.mockResolvedValueOnce([{ ...livePosition(7), owner: '0x0000000000000000000000000000000000000002' }]);
    await expect(move(ctx, { positionIds: [7], toAgentId: 2 })).rejects.toThrow('not owned');
    expect(indexer.displaySnapshot).not.toHaveBeenCalled();
    expect(pools.moveStake).not.toHaveBeenCalled();
  });

  it.each([true, false])('uses matching indexed yield inputs without historical RPC (settled: %s)', async settled => {
    const { ctx, snapshot, requests, pools, rewards, stack, indexer } = fixture();
    snapshot.pools[1]!.settled = settled;
    const result = await poolsView(ctx);
    expect(result.pools[0]?.yield).toEqual({ ...poolYield(settled ? 10n : 20n, 100n, 21, stack.epochDuration, stack.genesis, settled), reward: settled ? '10' : '20', power: '200', minLockEpochs: 1, maxLockEpochs: 104 });
    expect(requests.map(row => row.method)).toEqual(['minStakeEpochs', 'MAX_STAKE_EPOCHS']);
    expect(pools.allStakerPositionIds).not.toHaveBeenCalled();
    expect(pools.totalPowerWeightAtEpoch).not.toHaveBeenCalled();
    expect(rewards.stakerEpochBudget).not.toHaveBeenCalled();
    expect(indexer.pool).not.toHaveBeenCalled();
    expect(result.totalActiveStake).toBe('1000');
    expect((await singlePool(ctx, 1))).toMatchObject({ stakers: 2, openPositions: 3 });
    expect(indexer.pool).toHaveBeenCalledWith(1, 16);
  });

  it('uses combined-feed pool summaries without another wallet enumeration', async () => {
    const { ctx, feed, requests, indexer } = fixture();
    feed.positions.push({ ...feed.positions[0]!, id: 8, stakeStartEpoch: 23, amount: '40', power: '0', state: 'pending' });
    feed.summary[0] = { agentId: 1, positionIds: [7, 8], activeStake: '100', pendingStake: '40', power: '200' };
    const result = await poolsView(ctx);
    expect(indexer.positions).not.toHaveBeenCalled();
    expect(requests.some(row => row.method === 'positionWeightAtEpoch')).toBe(false);
    expect(result.pools[0]).toMatchObject({ yourStake: '100', yourPendingStake: '40', yourPower: '200', yourPositionIds: [7, 8] });
    expect(result.yourPendingStake).toBe('40');
  });

  it.each(['missing', 'zero', 'stale', 'offline'])('keeps %s history distinct without historical RPC amplification', async mode => {
    const { ctx, snapshot, requests, rewards, accounting, indexer } = fixture();
    if (mode === 'missing') snapshot.pools = snapshot.pools.filter(row => row.epoch === 22);
    if (mode === 'zero') snapshot.pools[1]!.settledEmission = '0';
    if (mode === 'stale') snapshot.indexedAt -= 121;
    if (mode === 'offline') {
      indexer.displaySnapshot.mockRejectedValue(new IndexerError('offline', 'https://scan/graphql'));
      indexer.pools.mockRejectedValue(new IndexerError('offline', 'https://scan/api'));
    }
    const result = await poolsView(ctx);
    expect(result.pools[0]?.yield).toMatchObject({ status: mode === 'zero' ? 'settled' : 'unavailable', reward: mode === 'zero' ? '0' : null });
    expect(requests.some(row => row.method === 'poolEpochEmissions')).toBe(false);
    expect(requests.some(row => ['poolWeightAtEpoch', 'poolActiveStakeAtEpoch', 'agentEpochUsage'].includes(row.method) && row.args?.includes(21))).toBe(false);
    expect(rewards.stakerEpochBudget).not.toHaveBeenCalledWith(21);
    expect(accounting.totalWeightedPoolPointsByEpoch).not.toHaveBeenCalledWith(21);
  });
});

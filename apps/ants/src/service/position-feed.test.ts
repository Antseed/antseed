import { describe, expect, it, vi } from 'vitest';
import { AntscanIndexer } from './indexer.js';
import { parseRewardPage, fetchRewardPositions } from './position-feed.js';
import { indexedWalletRewards, liveWalletPositions } from './indexed-wallet.js';
import type { AntsContext } from './context.js';

const owner = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
const blockHash = `0x${'ab'.repeat(32)}`;
const position = (id = 7) => ({ id: String(id), owner, agentId: '1', amount: '100', weightAmount: '200', stakeStartEpoch: '1', stakeEndEpoch: '30', closedAtEpoch: '0', withdrawn: false, maxLocked: false, restaked: false, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: null, closedBy: null, replacementIds: [], sourceId: null });
const rewards = { status: 'available', pending: '15', claimedThroughEpoch: '1', calculatedThroughEpoch: '21', requiresPoolIndexing: true };
function rewardPage(ids = [7], nextCursor: string | null = null) {
  return { owner, currentEpoch: '22', requiresLiveValidation: true,
    positions: ids.map(id => ({ ...position(id), state: 'active', power: '200', nextPower: '190', withdrawableEpoch: '1', maxLockedNext: false, changePending: false, rewards })),
    liveSource: { currentEpoch: '22', fetchedAt: Math.floor(Date.now() / 1000), stale: false, complete: true, cacheTtlSeconds: 15 },
    source: { schemaVersion: 1, chainId: 8453, contracts: { sellerPools: owner, sellerPoolsRewards: owner }, indexedBlock: 100, indexedBlockHash: blockHash, indexedAt: Math.floor(Date.now() / 1000), revision: `${blockHash}:22`, stale: false, complete: true, historyComplete: true, historyFromBlock: 1 },
    pagination: { limit: 100, hasMore: nextCursor !== null, nextCursor } };
}
function context() {
  return { address: owner, chain: { evmChainId: 8453, sellerPoolsAddress: owner, sellerPoolsRewardsAddress: owner }, localPositionIds: new Map(), positionReadBarriers: new Map() } as unknown as AntsContext;
}

describe('Antscan position feeds', () => {
  it('shares one additive response between live state and rewards', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify(rewardPage())));
    const indexer = new AntscanIndexer('https://scan', fetcher);
    const ctx = context();
    ctx.indexer = () => indexer;
    const [live, reward] = await Promise.all([liveWalletPositions(ctx, 22), indexedWalletRewards(ctx, 22)]);
    expect(live).toBe(reward);
    expect(live).toMatchObject({ totals: { activeStake: '100', power: '200' }, positions: [{ id: 7, nextPower: '190', maxLockedNext: false, changePending: false }], summary: [{ agentId: 1, positionIds: [7] }] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://scan/api/staking/positions?owner=${owner}&include=rewards&includeClosed=1&limit=100`);
  });
  it('exhausts combined pagination including closed positions and coalesces reads', async () => {
    const first = rewardPage(Array.from({ length: 100 }, (_, index) => 200 - index), 'next');
    const last = rewardPage([100]);
    last.positions[0]!.closedAtEpoch = '20';
    const fetcher = vi.fn(async (input: string | URL | Request) => new Response(JSON.stringify(String(input).includes('cursor=') ? last : first)));
    const indexer = new AntscanIndexer('https://scan', fetcher);
    const [result, duplicate] = await Promise.all([indexer.rewardPositions(owner, true), indexer.rewardPositions(owner, true)]);
    expect(result.positions).toHaveLength(101);
    expect(result).toBe(duplicate);
    expect(result.positions.at(-1)).toMatchObject({ id: 100, closedAtEpoch: 20, rewards: { pending: '15' } });
    expect(result.totals).toEqual({ activeStake: '10000', pendingStake: '0', power: '20000' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    const query = new URL(String(fetcher.mock.calls[0]![0])).searchParams;
    expect(Object.fromEntries(query)).toEqual({ owner, include: 'rewards', includeClosed: '1', limit: '100', rewardStatus: 'outstanding' });
    indexer.invalidate();
    await indexer.rewardPositions(owner, true);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('discards all partial pages and restarts once after a 409', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(rewardPage([9], 'next'))))
      .mockResolvedValueOnce(new Response('snapshot changed', { status: 409 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(rewardPage([8]))));
    const result = await new AntscanIndexer('https://scan', fetcher).rewardPositions(owner);
    expect(result.positions.map(row => row.id)).toEqual([8]);
    expect(String(fetcher.mock.calls[2]![0])).not.toContain('cursor=');
  });
  it('bounds conflict retries and does not cache failures', async () => {
    const fetcher = vi.fn(async () => new Response('snapshot changed', { status: 409 }));
    const indexer = new AntscanIndexer('https://scan', fetcher);
    await expect(indexer.rewardPositions(owner)).rejects.toThrow('409');
    expect(fetcher).toHaveBeenCalledTimes(2);
    await expect(indexer.rewardPositions(owner)).rejects.toThrow('409');
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('rejects unavailable deployments instead of returning an empty wallet', async () => {
    const indexer = new AntscanIndexer('https://scan', async () => new Response('backfilling', { status: 503 }));
    await expect(indexer.rewardPositions(owner)).rejects.toThrow('503');
    expect(() => parseRewardPage({ positions: [] }, owner)).toThrow();
  });
  it('keeps unknown rewards distinct from zero', () => {
    const raw = rewardPage();
    Object.assign(raw.positions[0]!.rewards = { ...rewards }, { status: 'unavailable', pending: null, claimedThroughEpoch: null, calculatedThroughEpoch: null, requiresPoolIndexing: null });
    expect(parseRewardPage(raw, owner).positions[0]!.rewards.pending).toBeNull();
  });
  it.each(['identity', 'schema', 'pagination', 'duplicate', 'amount'])('rejects malformed %s', kind => {
    const raw = rewardPage();
    if (kind === 'identity') raw.owner = other;
    if (kind === 'schema') raw.source.schemaVersion = 2;
    if (kind === 'pagination') raw.pagination.hasMore = true;
    if (kind === 'duplicate') raw.positions.push(raw.positions[0]!);
    if (kind === 'amount') raw.positions[0]!.amount = '-1';
    expect(() => parseRewardPage(raw, owner)).toThrow();
  });
  it('rejects duplicate IDs, repeated cursors and mismatched snapshots across pages', async () => {
    await expect(fetchRewardPositions(owner, false, async () => rewardPage([7], 'next'))).rejects.toThrow('Duplicate');
    let page = 0;
    await expect(fetchRewardPositions(owner, false, async () => rewardPage([10 - page++], 'next'))).rejects.toThrow('Repeated');
    page = 0;
    await expect(fetchRewardPositions(owner, false, async () => {
      const raw = rewardPage([10 - page++], 'next');
      raw.source.indexedBlock += page;
      return raw;
    })).rejects.toThrow('changed between pages');
  });
  it('does not count a source closing next epoch as pending stake', async () => {
    const page = rewardPage([7, 8, 9]);
    page.positions[1] = { ...page.positions[1]!, stakeStartEpoch: '23', state: 'pending' };
    page.positions[2] = { ...page.positions[2]!, stakeStartEpoch: '23', closedAtEpoch: '23', state: 'closed', power: '0' };
    const data = await fetchRewardPositions(owner, false, async () => page);
    expect(data.summary).toMatchObject([{ positionIds: [7, 8, 9], activeStake: '100', pendingStake: '100' }]);
    expect(data.totals).toEqual({ activeStake: '100', pendingStake: '100', power: '400' });
  });

  it('computes wallet totals across every page instead of trusting page-scoped totals', async () => {
    const first = { ...rewardPage([8], 'next'), pageTotals: { activeStake: '999', pendingStake: '999', power: '999' } };
    const last = rewardPage([7]);
    last.positions[0]!.stakeStartEpoch = '23';
    last.positions[0]!.power = '0';
    const data = await fetchRewardPositions(owner, false, async path => path.includes('cursor=') ? last : first);
    expect(data.totals).toEqual({ activeStake: '100', pendingStake: '100', power: '200' });
    expect(data.summary).toMatchObject([{ positionIds: [8, 7], activeStake: '100', pendingStake: '100' }]);
  });
  it('keeps live freshness separate from reward freshness across pages', async () => {
    const first = rewardPage([8], 'next');
    const last = rewardPage([7]);
    last.liveSource.currentEpoch = '23';
    const data = await fetchRewardPositions(owner, false, async path => path.includes('cursor=') ? last : first);
    expect(data.liveSource.complete).toBe(false);
    expect(data.source.complete).toBe(true);
  });
});

describe('snapshot eligibility', () => {
  it.each(['stale', 'incomplete', 'history', 'chain', 'contracts', 'epoch', 'old', 'future', 'barrier', 'unknown'])('rejects %s rewards', async kind => {
    const ctx = context();
    const raw = rewardPage();
    if (kind === 'stale') raw.source.stale = true;
    if (kind === 'incomplete') raw.source.complete = false;
    if (kind === 'history') raw.source.historyComplete = false;
    if (kind === 'chain') raw.source.chainId = 1;
    if (kind === 'contracts') raw.source.contracts.sellerPools = other;
    if (kind === 'epoch') raw.currentEpoch = '23';
    if (kind === 'old') raw.source.indexedAt -= 3601;
    if (kind === 'future') raw.source.indexedAt += 31;
    if (kind === 'barrier') ctx.positionReadBarriers.set(owner, { block: 101, at: 0 });
    if (kind === 'unknown') raw.positions[0]!.rewards = { ...rewards, status: 'unavailable' };
    ctx.indexer = () => ({ rewardPositions: async () => parseRewardPage(raw, owner) }) as never;
    await expect(indexedWalletRewards(ctx, 22)).rejects.toThrow();
  });
  it('accepts current rewards and does not require zero-reward local IDs in outstanding results', async () => {
    const ctx = context();
    ctx.localPositionIds.set(8, owner);
    ctx.indexer = () => ({ rewardPositions: async () => parseRewardPage(rewardPage(), owner) }) as never;
    expect((await indexedWalletRewards(ctx, 22, true)).positions).toHaveLength(1);
  });
  it.each(['stale', 'incomplete', 'epoch', 'old', 'barrier', 'chain', 'contracts', 'null-field'])('rejects %s live data', async kind => {
    const ctx = context();
    const raw = rewardPage();
    if (kind === 'stale') raw.liveSource.stale = true;
    if (kind === 'incomplete') raw.liveSource.complete = false;
    if (kind === 'epoch') raw.currentEpoch = raw.liveSource.currentEpoch = '23';
    if (kind === 'old') raw.liveSource.fetchedAt -= 15;
    if (kind === 'barrier') ctx.positionReadBarriers.set(owner, { block: 100, at: raw.liveSource.fetchedAt });
    if (kind === 'chain') raw.source.chainId = 1;
    if (kind === 'contracts') raw.source.contracts.sellerPools = other;
    if (kind === 'null-field') Object.assign(raw.positions[0]!, { nextPower: null });
    ctx.indexer = () => ({ rewardPositions: async () => fetchRewardPositions(owner, false, async () => raw) }) as never;
    await expect(liveWalletPositions(ctx, 22)).rejects.toThrow();
  });
  it('accepts complete fresh live state', async () => {
    const ctx = context();
    ctx.indexer = () => ({ rewardPositions: async () => fetchRewardPositions(owner, false, async () => rewardPage()) }) as never;
    expect((await liveWalletPositions(ctx, 22)).totals.power).toBe('200');
  });
  it('retains indexed rewards when live RPC enrichment fails', async () => {
    const ctx = context();
    const raw = rewardPage();
    Object.assign(raw.liveSource, { fetchedAt: null, stale: true, complete: false });
    Object.assign(raw.positions[0]!, { power: null, nextPower: null, withdrawableEpoch: null, maxLockedNext: null, changePending: null });
    ctx.indexer = () => new AntscanIndexer('https://scan', async () => new Response(JSON.stringify({ ...raw, liveError: 'RPC failed' })));
    expect((await indexedWalletRewards(ctx, 22)).positions[0]!.rewards.pending).toBe('15');
    await expect(liveWalletPositions(ctx, 22)).rejects.toThrow('RPC failed');
  });
  it('keeps live state usable when reward epochs lag or rewards are unavailable', async () => {
    const ctx = context();
    const raw = rewardPage();
    raw.currentEpoch = '21';
    Object.assign(raw.positions[0]!.rewards = { ...rewards }, { status: 'unavailable', pending: null });
    ctx.indexer = () => new AntscanIndexer('https://scan', async () => new Response(JSON.stringify(raw)));
    expect((await liveWalletPositions(ctx, 22)).totals.power).toBe('200');
    await expect(indexedWalletRewards(ctx, 22)).rejects.toThrow('stale');
  });
});

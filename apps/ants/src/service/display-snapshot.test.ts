import { describe, expect, it, vi } from 'vitest';
import { AntscanIndexer, IndexerError } from './indexer.js';
import { displayData } from './display-snapshot.js';
import type { AntsContext, ResolvedStack } from './context.js';

const owner = '0x0000000000000000000000000000000000000001';
const checkpoint = () => ({ status: { base: { id: 8453, block: { number: 100, timestamp: Math.floor(Date.now() / 1000) } } } });
const epoch = (value: number) => ({ epoch: String(value), totalActiveStake: '100', totalPowerWeight: '200', totalSellerPoints: '3', totalBuyerPoints: '4', totalWeightedPoolPoints: '5', volumeUsdc: '6', requests: '7', stakerBudget: '8', snapshotBlock: 90, lastBlockNumber: 99 });
const pool = (agentId = '1') => ({ agentId, epoch: '21', weight: '200', activeStake: '100', usagePoints: '2', weightedUsagePoints: '3', settledEmission: '4', settled: true, snapshotBlock: 90, lastBlockNumber: 99 });
const page = (items: unknown[], hasNextPage = false, endCursor: string | null = null) => ({ items, pageInfo: { hasNextPage, endCursor } });
function responseBody() {
  return { data: {
    _meta: checkpoint(), epochs: page([epoch(22), epoch(21)]),
    pools: page([pool()]),
  } };
}
function fixture(body: unknown = responseBody()) {
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body)));
  const indexer = new AntscanIndexer('https://scan/', fetchImpl);
  const ctx = { chain: { evmChainId: 8453 }, address: owner, indexer: () => indexer } as unknown as AntsContext;
  const stack = { currentEpoch: 22, genesis: Math.floor(Date.now() / 1000) - 22 * 604800 - 100, epochDuration: 604800 } as ResolvedStack;
  return { fetchImpl, indexer, ctx, stack };
}

describe('Antscan display snapshots', () => {
  it('fetches and shares one snapshot across display consumers, retaining checkpoint and row blocks', async () => {
    const { indexer, fetchImpl, ctx, stack } = fixture();
    const [first, second] = await Promise.all([displayData(ctx, stack), displayData(ctx, stack)]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.source).toMatchObject({ source: 'indexer', indexedBlock: 100 });
    expect(first.snapshot?.epochs[0]).toMatchObject({ epoch: 22, totalActiveStake: '100', snapshotBlock: 90 });
    expect(first.snapshot?.pools[0]).toMatchObject({ agentId: 1, activeStake: '100', lastBlockNumber: 99 });
    indexer.invalidate();
    await indexer.displaySnapshot(22);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('follows each dataset cursor and never treats the first page as a complete pool list', async () => {
    const body = responseBody();
    body.data.pools = page([pool('7')], true, 'next-page');
    const { indexer, fetchImpl } = fixture(body);
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(new Response(JSON.stringify({ data: { _meta: body.data._meta, pools: page([pool('8')]) } })));
    expect((await indexer.displaySnapshot(22)).pools.map(row => row.agentId)).toEqual([7, 8]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const request = JSON.parse((fetchImpl.mock.calls[1] as unknown as [string, RequestInit])[1].body as string).query;
    expect(request).toContain('after:"next-page"');
    expect(request).not.toContain('stakingEpochs');
  });

  it('shares wallet-independent statistics without querying positions', async () => {
    const { ctx, stack, fetchImpl } = fixture();
    const otherWallet = { ...ctx, address: '0x0000000000000000000000000000000000000002' } as AntsContext;
    const [first, second] = await Promise.all([displayData(ctx, stack), displayData(otherWallet, stack)]);
    expect(first).toEqual(second);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const query = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).query;
    expect(query).not.toContain('stakePositions');
    expect(query).not.toContain('owner:');
    expect(first.snapshot).not.toHaveProperty('positions');
  });

  it('still checks each wallet transaction barrier against a shared snapshot', async () => {
    const { ctx, stack, fetchImpl } = fixture();
    expect((await displayData(ctx, stack)).snapshot).not.toBeNull();
    const afterTransaction = { ...ctx, positionReadBarriers: new Map([[owner, { block: 101, at: Math.floor(Date.now() / 1000) }]]) } as AntsContext;
    expect((await displayData(afterTransaction, stack)).source.error).toContain('not caught up');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['wrong-chain', 'stale', 'future-clock', 'previous-epoch'])('falls back explicitly for %s snapshots', async mode => {
    const body = responseBody();
    const now = Math.floor(Date.now() / 1000);
    if (mode === 'wrong-chain') body.data._meta.status.base.id = 31337;
    if (mode === 'stale') body.data._meta.status.base.block.timestamp = now - 121;
    if (mode === 'future-clock') body.data._meta.status.base.block.timestamp = now + 31;
    if (mode === 'previous-epoch') body.data._meta.status.base.block.timestamp = now - 101;
    const { ctx, stack } = fixture(body);
    const display = await displayData(ctx, stack);
    expect(display.snapshot).toBeNull();
    expect(display.source).toMatchObject({ source: 'chain', error: expect.any(String) });
  });

  it.each(['principal', 'pool-flag', 'network', 'current-epoch', 'duplicate', 'ahead-of-checkpoint'])('rejects incomplete or inconsistent %s data without inventing zeros', async mode => {
    const body = responseBody();
    if (mode === 'principal') delete (body.data.pools.items[0] as Record<string, unknown>).activeStake;
    if (mode === 'pool-flag') delete (body.data.pools.items[0] as Record<string, unknown>).settled;
    if (mode === 'network') delete (body.data.epochs.items[0] as Record<string, unknown>).stakerBudget;
    if (mode === 'current-epoch') body.data.epochs.items = [epoch(21)];
    if (mode === 'duplicate') body.data.pools.items.push(pool());
    if (mode === 'ahead-of-checkpoint') (body.data.pools.items[0] as Record<string, unknown>).snapshotBlock = 101;
    const { indexer } = fixture(body);
    await expect(indexer.displaySnapshot(22)).rejects.toBeInstanceOf(IndexerError);
  });

  it('accepts explicit zero-valued historical rows', async () => {
    const body = responseBody();
    Object.assign(body.data.pools.items[0] as object, { weight: '0', activeStake: '0', usagePoints: '0', weightedUsagePoints: '0', settledEmission: '0' });
    const { indexer } = fixture(body);
    const snapshot = await indexer.displaySnapshot(22);
    expect(snapshot.pools[0]?.activeStake).toBe('0');
  });

  it.each(['cursor', 'checkpoint', 'second-page-error'])('rejects a broken %s during pagination and does not cache partial results', async mode => {
    const body = responseBody();
    body.data.pools = page([pool('7')], true, 'same');
    const second = { data: { _meta: checkpoint(), pools: page([pool('8')], mode === 'cursor', 'same') } };
    if (mode === 'checkpoint') second.data._meta.status.base.block.number++;
    const { indexer, fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response(JSON.stringify(body))).mockResolvedValueOnce(new Response(JSON.stringify(mode === 'second-page-error' ? { errors: [{ message: 'unavailable' }] } : second)));
    await expect(indexer.displaySnapshot(22)).rejects.toBeInstanceOf(IndexerError);
    expect((await indexer.displaySnapshot(22)).pools).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries after HTTP and JSON failures rather than caching errors', async () => {
    const { indexer, fetchImpl } = fixture();
    fetchImpl.mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(new Response('not json'));
    await expect(indexer.displaySnapshot(22)).rejects.toThrow('HTTP 503');
    await expect(indexer.displaySnapshot(22)).rejects.toBeInstanceOf(IndexerError);
    expect((await indexer.displaySnapshot(22)).pools).toHaveLength(1);
  });
});

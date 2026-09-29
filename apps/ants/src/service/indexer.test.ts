import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntscanIndexer, IndexerError } from './indexer.js';

describe('bounded explorer recovery', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const success = () => new Response(JSON.stringify({ currentEpoch: 22, pools: [] }));

  it('keeps a timed-out read pending until its automatic retry succeeds', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    const request = vi.fn<typeof fetch>().mockImplementationOnce((_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(options!.signal!.reason));
    })).mockImplementationOnce(async () => success());
    const indexer = new AntscanIndexer('https://scan', request);
    const completed = vi.fn();
    const result = indexer.pools().then(completed);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(completed).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(750);
    await result;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ currentEpoch: 22 }));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([408, 429, 500, 502, 503, 504])('retries HTTP %s once', async status => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status })).mockImplementationOnce(async () => success());
    const result = new AntscanIndexer('https://scan', request).pools();
    await vi.advanceTimersByTimeAsync(750);
    expect((await result).currentEpoch).toBe(22);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('stops after two failed attempts, preserving HTTP status, and allows a fresh read', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockImplementation(async () => new Response('', { status: 503 }));
    const indexer = new AntscanIndexer('https://scan', request);
    const result = indexer.pools().catch(error => error);
    await vi.advanceTimersByTimeAsync(18_000);
    expect(await result).toMatchObject({ status: 503 });
    expect(request).toHaveBeenCalledTimes(2);
    request.mockImplementation(async () => success());
    expect((await indexer.pools()).currentEpoch).toBe(22);
  });

  it.each(['seconds', 'date'])('honors Retry-After in %s', async format => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
    const retryAfter = format === 'seconds' ? '2' : new Date(Date.now() + 2_000).toUTCString();
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': retryAfter } })).mockImplementationOnce(async () => success());
    const result = new AntscanIndexer('https://scan', request).pools();
    await vi.advanceTimersByTimeAsync(750);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_250);
    await result;
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not wait beyond the attempt budget for Retry-After', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status: 429, headers: { 'retry-after': '60' } }));
    await expect(new AntscanIndexer('https://scan', request).pools()).rejects.toMatchObject({ status: 429 });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('shares pending reads beyond cache TTL and starts freshness at completion', async () => {
    vi.useFakeTimers();
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const indexer = new AntscanIndexer('https://scan', request, 100);
    const first = indexer.pools();
    await vi.advanceTimersByTimeAsync(200);
    const second = indexer.pools();
    expect(request).toHaveBeenCalledTimes(1);
    finish(success());
    await Promise.all([first, second]);
    await indexer.pools();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404])('does not retry HTTP %s', async status => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('', { status }));
    await expect(new AntscanIndexer('https://scan', request).pools()).rejects.toMatchObject({ status });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('recovers from a network failure without retrying malformed JSON', async () => {
    vi.useFakeTimers();
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async () => success());
    const result = new AntscanIndexer('https://scan', request).pools();
    await vi.advanceTimersByTimeAsync(750);
    expect((await result).currentEpoch).toBe(22);
    const malformed = vi.fn<typeof fetch>().mockResolvedValue(new Response('not JSON'));
    await expect(new AntscanIndexer('https://scan', malformed).pools()).rejects.toBeInstanceOf(SyntaxError);
    expect(malformed).toHaveBeenCalledTimes(1);
  });

  it('stops repeated timeouts within the resource budget, including stalled response bodies', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Timed out', 'TimeoutError')), milliseconds);
      return controller.signal;
    });
    const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => new Response(new ReadableStream({
      start(controller) { options!.signal!.addEventListener('abort', () => controller.error(options!.signal!.reason)); },
    })));
    const result = new AntscanIndexer('https://scan', request).pools().catch(error => error);
    await vi.advanceTimersByTimeAsync(16_750);
    expect(await result).toBeInstanceOf(IndexerError);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('does not cache an invalidated in-flight read over a newer read', async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn<typeof fetch>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
      .mockImplementation(async () => new Response(JSON.stringify({ currentEpoch: 23, pools: [] })));
    const indexer = new AntscanIndexer('https://scan', request);
    const previous = indexer.pools();
    indexer.invalidate();
    expect((await indexer.pools()).currentEpoch).toBe(23);
    finish(success());
    expect((await previous).currentEpoch).toBe(22);
    expect((await indexer.pools()).currentEpoch).toBe(23);
    expect(request).toHaveBeenCalledTimes(2);
  });
});

function fakeFetch(routes: Record<string, unknown>, calls: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace('https://scan', '');
    const body = routes[path];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

describe('AntscanIndexer', () => {
  it('retains PR9 active and pending pool stake', async () => {
    const indexer = new AntscanIndexer('https://scan', fakeFetch({
      '/api/staking/pools/1?epochs=8': { pool: null, epochs: [], activeStake: '123', pendingStake: '45', openPositions: 3, stakers: 2 },
    }));
    expect(await indexer.pool(1)).toMatchObject({ activeStake: '123', pendingStake: '45' });
  });
  it('normalises pool rows, keeping amounts as strings and ids as numbers', async () => {
    const indexer = new AntscanIndexer('https://scan/', fakeFetch({
      '/api/staking/pools': {
        currentEpoch: '22',
        network: { current: { epoch: '22', totalPowerWeight: '1000', totalActiveStake: '10', totalSellerPoints: '0', totalWeightedPoolPoints: '0', totalBuyerPoints: '0', volumeUsdc: '5', requests: '1', stakerBudget: '99' }, last: null },
        pools: [{ agentId: '84990', seller: '0xABCD', sellerName: 'Flash', registered: true, openPositions: 2, totalPositions: 3, securityShareBps: '100', activeStake: '250', pendingStake: '0', weight: '500', powerShareBps: 5000, lastWeight: '400', usagePoints: '1', weightedUsagePoints: '1', lastUsagePoints: '0', volumeUsdc: '7', lastVolumeUsdc: '6', lastEmission: '12', lastEmissionSettled: false, lastRewardPer1kPower: '30', projectedEmission: '0', projectedRewardPer1kPower: null }],
      },
    }));
    const pools = await indexer.pools();
    expect(pools.currentEpoch).toBe(22);
    expect(pools.network.current?.stakerBudget).toBe('99');
    expect(pools.network.last).toBeNull();
    expect(pools.pools[0]).toMatchObject({ agentId: 84990, seller: '0xabcd', sellerName: 'Flash', weight: '500', powerShareBps: 5000, lastRewardPer1kPower: '30', projectedRewardPer1kPower: null });
  });

  it('groups seller epochs by lowercase address and caches identical requests briefly', async () => {
    const calls: string[] = [];
    const indexer = new AntscanIndexer('https://scan', fakeFetch({
      '/api/staking/seller-epochs?epochs=3': { currentEpoch: '22', fromEpoch: '20', rows: [
        { seller: '0xAA', epoch: '22', agentId: null, volumeUsdc: '5', points: '5', weightedPoints: '0', requests: '2' },
        { seller: '0xaa', epoch: '21', agentId: '7', volumeUsdc: '9', points: '9', weightedPoints: '0', requests: '1' },
      ] },
    }, calls));
    const first = await indexer.sellerEpochs(3);
    await indexer.sellerEpochs(3);
    expect(calls).toHaveLength(1);
    expect(first.get('0xaa')?.map((row) => row.epoch)).toEqual([22, 21]);
  });

  it('parses positions including close metadata', async () => {
    const indexer = new AntscanIndexer('https://scan', fakeFetch({
      '/api/staking/positions?owner=0xabc&includeClosed=1': { positions: [
        { id: '7', owner: '0xABC', agentId: '1', amount: '10', weightAmount: '12', stakeStartEpoch: '20', stakeEndEpoch: '30', closedAtEpoch: '22', closedBy: 'split', replacementIds: ['8', '9'], sourceId: null, restaked: false, maxLocked: false, withdrawn: false, returnedAmount: '0', slashedAmount: '0', createdAt: 1, closedAt: 2 },
      ] },
    }));
    const [position] = await indexer.positions('0xABC');
    expect(position).toMatchObject({ id: 7, closedAtEpoch: 22, closedBy: 'split', replacementIds: [8, 9], sourceId: null });
  });

  it('turns HTTP failures into IndexerError and does not cache them', async () => {
    const calls: string[] = [];
    const indexer = new AntscanIndexer('https://scan', fakeFetch({}, calls));
    await expect(indexer.pools()).rejects.toBeInstanceOf(IndexerError);
    await expect(indexer.pools()).rejects.toThrow(/HTTP 404/);
    expect(calls).toHaveLength(2);
  });
});

it('does not invent a zero staker count or historical volume when indexer fields are absent', async () => {
  const indexer = new AntscanIndexer('https://scan', fakeFetch({
    '/api/staking/pools/1?epochs=8': { pool: null, epochs: [{ epoch: 21 }, { epoch: 20, volumeUsdc: '0' }] },
  }));
  const detail = await indexer.pool(1);
  expect(detail.stakers).toBeNull();
  expect(detail.epochs.map(row => [row.epoch, row.volumeUsdc])).toEqual([[20, '0']]);
});

it('preserves missing yield inputs and incomplete network snapshots for RPC fallback', async () => {
  const indexer = new AntscanIndexer('https://scan', fakeFetch({
    '/api/staking/pools': { currentEpoch: 22, network: { current: { epoch: 22 } }, pools: [
      { agentId: 1, lastWeight: '0' },
      { agentId: 2, lastWeight: '0', lastEmission: '0', lastEmissionSettled: true },
    ] },
  }));
  const data = await indexer.pools();
  expect(data.network.current?.complete).toBe(false);
  expect(data.pools[0]?.historicalYield).toBeNull();
  expect(data.pools[1]?.historicalYield).toEqual({ power: '0', reward: '0', settled: true });
});

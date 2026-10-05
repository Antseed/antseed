import { describe, expect, it, vi } from 'vitest';
import { sellerModels } from './seller-models.js';

const address = '0x0000000000000000000000000000000000000001';
const other = '0x0000000000000000000000000000000000000002';
const offering = { id: 'offer', sellerAddress: address, service: 'test-model', serviceDisplayName: 'Test Model', provider: 'openai', categories: ['code'], inputUsdPerMillion: 0, outputUsdPerMillion: 2 };
const emissions = { currentEpoch: '23', genesis: '1775728461', epochDuration: '604800' };
const period = { from: 1789034061, to: 1789638861, startInclusive: true, endExclusive: true, basis: 'settlement_time' };
const model = { serviceId: 'model', name: 'Test Model', requestCount: '3', inputTokens: '20', outputTokens: '10', volumeUsdc: '1500000' };
const totals = { settledVolumeUsdc: '1600000', attributedVolumeUsdc: '1500000', unattributedVolumeUsdc: '100000', excessAttributedVolumeUsdc: '0' };
const aggregate = { seller: address, period, coverage: { records: 'all_indexed_records_in_period' }, totals, models: [model] };
const catalog = { status: 'live', updatedAt: 1789810000000, offerings: [offering, { ...offering, sellerAddress: other }] };
const fetcher = (usage: unknown = aggregate, epochData: unknown = emissions, catalogData: unknown = catalog) => vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).includes('/marketplace') ? catalogData : String(url).endsWith('/api/emissions') ? epochData : usage))) as unknown as typeof fetch;

describe('Antscan seller model details', () => {
  it('requests all seller records for the last completed epoch, not a capped network sample', async () => {
    const fetchImpl = fetcher();
    const result = await sellerModels('https://antscan.test/', address, fetchImpl);
    expect(result.offerings).toEqual([{ id: 'offer', name: 'Test Model', provider: 'openai', categories: ['code'], inputUsdPerMillion: 0, outputUsdPerMillion: 2 }]);
    expect(result.usage).toEqual([{ serviceId: 'model', name: 'Test Model', requests: '3', inputTokens: '20', outputTokens: '10', volumeUsdc: '1500000' }]);
    expect(result).toMatchObject({ catalogStatus: 'live', usageStatus: 'available', period: { epoch: 22, from: period.from, to: period.to }, totals, usageError: null });
    expect(fetchImpl).toHaveBeenCalledWith(`https://antscan.test/api/sellers/${address}/model-usage?from=${period.from}&to=${period.to}`, expect.anything());
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('sorts by settled volume without losing integer precision and falls back to service IDs', async () => {
    const result = await sellerModels('https://antscan.test', address, fetcher({ ...aggregate, models: [{ ...model, volumeUsdc: '9007199254740992' }, { ...model, serviceId: 'larger', name: null, volumeUsdc: '9007199254740993' }] }));
    expect(result.usage.map(row => row.name)).toEqual(['larger', 'Test Model']);
  });
  it('distinguishes an empty valid period from unavailable data', async () => {
    expect(await sellerModels('https://empty.test', address, fetcher({ ...aggregate, models: [] }))).toMatchObject({ usageStatus: 'available', usage: [] });
    expect(await sellerModels('https://bad.test', address, fetcher({}))).toMatchObject({ catalogStatus: 'live', usageStatus: 'unavailable', totals: null });
  });
  it.each([
    { ...aggregate, seller: other },
    { ...aggregate, period: { ...period, to: period.to + 1 } },
    { ...aggregate, period: { ...period, endExclusive: false } },
    { ...aggregate, coverage: { records: 'sample' } },
    { ...aggregate, models: [{ ...model, requestCount: '-1' }] },
    { ...aggregate, models: [model, model] },
  ])('preserves the catalog but rejects invalid aggregate data', async usage => {
    expect(await sellerModels('https://bad.test', address, fetcher(usage))).toMatchObject({ catalogStatus: 'live', usageStatus: 'unavailable', usage: [], totals: null });
  });
  it.each([{ ...emissions, currentEpoch: '0' }, { ...emissions, epochDuration: '0' }, { ...emissions, genesis: '99999999999999999' }])('rejects unavailable or unsafe epoch boundaries', async epochData => {
    const fetchImpl = fetcher(aggregate, epochData);
    expect((await sellerModels('https://bad.test', address, fetchImpl)).usageStatus).toBe('unavailable');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('retains usage when the marketplace catalog is unavailable', async () => {
    expect(await sellerModels('https://antscan.test', address, fetcher(aggregate, emissions, {}))).toMatchObject({ catalogStatus: 'unavailable', usageStatus: 'available' });
  });
  it('explains a missing aggregate API without falling back to a sample', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => String(url).includes('/model-usage?') ? new Response('', { status: 404 }) : new Response(JSON.stringify(String(url).includes('/marketplace') ? catalog : emissions))) as unknown as typeof fetch;
    expect(await sellerModels('https://old.test', address, fetchImpl)).toMatchObject({ catalogStatus: 'live', usageStatus: 'unavailable', usageError: expect.stringContaining('does not expose the model-usage API') });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('handles HTTP failures without inventing totals', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 503 })) as unknown as typeof fetch;
    expect(await sellerModels('https://offline.test', address, fetchImpl)).toMatchObject({ catalogStatus: 'unavailable', usageStatus: 'unavailable', usage: [], offerings: [], totals: null });
  });
  it('does not request a disabled explorer or accept invalid seller paths', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    expect((await sellerModels('', address, fetchImpl)).usageStatus).toBe('unavailable');
    await expect(sellerModels('https://explorer.test', '../admin', fetchImpl)).rejects.toThrow('Seller must be an address');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

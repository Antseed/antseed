import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './api';

afterEach(() => vi.unstubAllGlobals());

describe('seller model API failures', () => {
  it('recognizes indexer syncing without interpreting it as a failed request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, state: 'syncing' }), { status: 202 })));
    await expect(api.positions()).rejects.toMatchObject({ name: 'IndexerSyncingError' });
  });

  it('explains a missing backend route instead of blaming Antscan', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, error: 'Not found' }), { status: 404 })));
    await expect(api.sellerModels('0x0000000000000000000000000000000000000001')).rejects.toMatchObject({
      status: 404, message: expect.stringContaining('Restart the updated desktop or dashboard process'),
    });
  });

  it('preserves transport failures without incorrectly requesting a backend upgrade', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));
    await expect(api.sellerModels('0x0000000000000000000000000000000000000001')).rejects.toEqual(new ApiError('Network error: Connection refused', 0));
  });

  it('keeps upstream unavailability separate from a failed local API request', async () => {
    const data = { catalogStatus: 'unavailable', usageStatus: 'unavailable', offerings: [], usage: [], period: null, totals: null, usageError: null };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }))));
    await expect(api.sellerModels('0x0000000000000000000000000000000000000001')).resolves.toEqual(data);
  });

  it('never labels an older backend sample as complete epoch totals', async () => {
    const data = { catalogStatus: 'live', usageStatus: 'available', sampledRecords: 1000, offerings: [], usage: [] };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, data }))));
    await expect(api.sellerModels('0x0000000000000000000000000000000000000001')).rejects.toMatchObject({
      message: expect.stringContaining('still uses sampled model data'),
    });
  });
});

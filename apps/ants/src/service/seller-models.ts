import type { SellerModelsView } from '../api-types.js';

type Row = Record<string, unknown>;
const rows = (value: unknown): Row[] => {
  if (!Array.isArray(value) || value.some(row => !row || typeof row !== 'object' || Array.isArray(row))) throw new Error('Invalid Antscan response');
  return value as Row[];
};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value : null;
const price = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const timestamp = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
const count = (value: unknown): bigint => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error('Invalid settlement counter');
  return BigInt(value);
};

export async function sellerModels(baseUrl: string | undefined, address: string, fetchImpl: typeof fetch = fetch): Promise<SellerModelsView> {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error('Seller must be an address.');
  const result: SellerModelsView = { fetchedAt: Date.now(), catalogStatus: 'unavailable', catalogUpdatedAt: null, offerings: [], usageStatus: 'unavailable', usageError: null, period: null, totals: null, usage: [] };
  if (!baseUrl) return result;
  const seller = address.toLowerCase();
  const read = async (path: string): Promise<Row> => {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, '')}${path}`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`Antscan ${response.status}`);
    return await response.json() as Row;
  };
  await Promise.all([
    (async () => {
      try {
        const catalog = await read(`/api/marketplace?seller=${seller}&limit=5000`);
        const offerings = rows(catalog.offerings).filter(row => text(row.sellerAddress)?.toLowerCase() === seller).map(row => {
          const id = text(row.id), name = text(row.serviceDisplayName) ?? text(row.service), provider = text(row.provider);
          if (!id || !name || !provider) throw new Error('Invalid offering');
          return { id, name, provider, categories: Array.isArray(row.categories) ? row.categories.filter((value): value is string => typeof value === 'string') : [], inputUsdPerMillion: price(row.inputUsdPerMillion), outputUsdPerMillion: price(row.outputUsdPerMillion) };
        });
        result.offerings = offerings;
        result.catalogStatus = catalog.status === 'live' ? 'live' : 'stale';
        result.catalogUpdatedAt = timestamp(catalog.updatedAt);
      } catch {}
    })(),
    (async () => {
      try {
        const emissions = await read('/api/emissions');
        const currentEpoch = count(emissions.currentEpoch);
        const genesis = count(emissions.genesis);
        const duration = count(emissions.epochDuration);
        if (currentEpoch < 1n) throw new Error('No completed epoch yet.');
        if (duration === 0n || duration > 366n * 86400n) throw new Error('Invalid epoch duration.');
        const epoch = Number(currentEpoch - 1n);
        const from = Number(genesis + (currentEpoch - 1n) * duration);
        const to = Number(genesis + currentEpoch * duration);
        if (![epoch, from, to].every(Number.isSafeInteger) || to > Math.floor(Date.now() / 1000)) throw new Error('Invalid epoch boundaries.');
        result.period = { epoch, from, to };
        const response = await read(`/api/sellers/${seller}/model-usage?from=${from}&to=${to}`);
        const period = response.period as Row | undefined;
        const coverage = response.coverage as Row | undefined;
        if (text(response.seller)?.toLowerCase() !== seller || period?.from !== from || period?.to !== to || period?.startInclusive !== true || period?.endExclusive !== true || period?.basis !== 'settlement_time' || coverage?.records !== 'all_indexed_records_in_period') throw new Error('Invalid model usage period or seller.');
        const totals = response.totals as Row | undefined;
        if (!totals) throw new Error('Missing model usage totals.');
        const parsedTotals = {
          settledVolumeUsdc: String(count(totals.settledVolumeUsdc)),
          attributedVolumeUsdc: String(count(totals.attributedVolumeUsdc)),
          unattributedVolumeUsdc: totals.unattributedVolumeUsdc === null ? null : String(count(totals.unattributedVolumeUsdc)),
          excessAttributedVolumeUsdc: String(count(totals.excessAttributedVolumeUsdc)),
        };
        const seen = new Set<string>();
        const usage = rows(response.models).map(row => {
          const serviceId = text(row.serviceId);
          if (!serviceId || seen.has(serviceId)) throw new Error('Invalid model usage identity.');
          seen.add(serviceId);
          return { serviceId, name: text(row.name) ?? serviceId, requests: String(count(row.requestCount)), inputTokens: String(count(row.inputTokens)), outputTokens: String(count(row.outputTokens)), volumeUsdc: String(count(row.volumeUsdc)) };
        });
        result.usage = usage.sort((first, second) => BigInt(first.volumeUsdc) > BigInt(second.volumeUsdc) ? -1 : BigInt(first.volumeUsdc) < BigInt(second.volumeUsdc) ? 1 : first.serviceId.localeCompare(second.serviceId));
        result.totals = parsedTotals;
        result.usageStatus = 'available';
      } catch (error) {
        result.usageError = error instanceof Error && error.message === 'Antscan 404'
          ? 'The configured Antscan server does not expose the model-usage API. The updated API must be deployed to Antscan.'
          : error instanceof Error && error.message === 'No completed epoch yet.' ? error.message : 'Antscan last-epoch usage could not load. Check the configured Antscan service and retry.';
      }
    })(),
  ]);
  return result;
}

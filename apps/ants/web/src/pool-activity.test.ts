import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { activityPoints, uniqueAdvertisedModels, PoolActivity, SellerModels } from './components/PoolActivity';
import { usePageData } from './data';
import type { SellerModelsView } from '../../src/api-types';

vi.mock('./data', () => ({ usePageData: vi.fn() }));

describe('last-epoch model usage', () => {
  const data: SellerModelsView = {
    fetchedAt: 1789810000000, catalogStatus: 'live', catalogUpdatedAt: null, offerings: [],
    usageStatus: 'available', usageError: null, period: { epoch: 22, from: 1789034061, to: 1789638861 },
    totals: { settledVolumeUsdc: '1600000', attributedVolumeUsdc: '1500000', unattributedVolumeUsdc: '100000', excessAttributedVolumeUsdc: '0' },
    usage: [{ serviceId: 'model', name: 'Test Model', requests: '3', inputTokens: '20', outputTokens: '10', volumeUsdc: '1500000' }],
  };
  const render = (view: SellerModelsView) => {
    vi.mocked(usePageData).mockReturnValue({ data: view, error: null, loading: false, reconciling: false, partial: false, updatedAt: 1, refresh: vi.fn() });
    return renderToStaticMarkup(createElement(SellerModels, { address: '0x0000000000000000000000000000000000000001' }));
  };
  it('keeps the epoch and totals without the period and explanatory copy', () => {
    const html = render(data);
    expect(html).toContain('Epoch 22');
    expect(html).not.toContain('end exclusive');
    expect(html).not.toContain('2026-09-10');
    expect(html).not.toContain('All indexed paid settlements');
    expect(html).not.toContain('free usage is excluded');
    expect(html).not.toContain('does not certify indexing completeness');
    expect(html).not.toContain('Unattributed volume has no matching model breakdown');
    expect(html).toContain('Unattributed: 0.1 USDC');
    expect(html).toContain('Test Model');
    expect(html).not.toContain('Recent sample');
  });
  it('offers retry and keeps the catalog visible when usage fails', () => {
    const html = render({ ...data, usageStatus: 'unavailable', usageError: 'Indexer is unavailable.', usage: [], totals: null });
    expect(html).toContain('Indexer is unavailable.');
    expect(html).toContain('Retry model data');
    expect(html).toContain('Advertised models');
    expect(html).not.toContain('No indexed model usage');
  });
  it('does not show zero unattributed volume when model totals exceed settlements', () => {
    expect(render({ ...data, totals: { ...data.totals!, unattributedVolumeUsdc: null, excessAttributedVolumeUsdc: '1' } })).toContain('unavailable (model totals exceed settlements)');
  });
});

describe('unique advertised models', () => {
  const offering = { id: 'model', name: 'Example model', provider: 'provider', inputUsdPerMillion: null, outputUsdPerMillion: null };

  it('shows a model once across categories and provider offerings', () => {
    const model = { ...offering, categories: [' Image ', 'image', 'text-generation', 'TEXT_GENERATION'] };
    expect(uniqueAdvertisedModels([model, model, { ...model, id: 'duplicate', name: ' EXAMPLE MODEL ', provider: 'other' }])).toEqual([{ name: 'Example model', providers: ['provider', 'other'] }]);
  });

  it('includes models without categories and preserves distinct model names', () => {
    const unknown = { ...offering, name: 'Image-sounding name', categories: ['  '] };
    const chat = { ...offering, id: 'chat', categories: ['chat'] };
    expect(uniqueAdvertisedModels([unknown, chat])).toEqual([{ name: unknown.name, providers: ['provider'] }, { name: chat.name, providers: ['provider'] }]);
    expect(uniqueAdvertisedModels([])).toEqual([]);
  });
});

describe('provider epoch charts', () => {
  it('sorts completed epochs and uses the matching network denominator', () => {
    expect(activityPoints([{ epoch: 23, usdc: '999' }, { epoch: 22, usdc: '25' }, { epoch: 21, usdc: '0' }], [{ epoch: 21, usdc: '100' }, { epoch: 22, usdc: '200' }], 23)).toEqual([
      { epoch: 21, volume: 0n, network: 100n, share: 0n }, { epoch: 22, volume: 25n, network: 200n, share: 1250n },
    ]);
  });
  it('keeps missing, zero, and inconsistent network totals unknown', () => {
    const points = activityPoints([1, 2, 3].map(epoch => ({ epoch, usdc: '100' })), [{ epoch: 2, usdc: '0' }, { epoch: 3, usdc: '50' }], 4);
    expect(points.map(point => point.share)).toEqual([null, null, null]);
  });
  it('renders two lines with accessible exact values and gaps across missing epochs', () => {
    const html = renderToStaticMarkup(createElement(PoolActivity, { volumes: [{ epoch: 19, usdc: '5000000' }, { epoch: 21, usdc: '10000000' }, { epoch: 22, usdc: '20000000' }], networkVolumes: [{ epoch: 19, usdc: '100000000' }, { epoch: 21, usdc: '100000000' }, { epoch: 22, usdc: '100000000' }], currentEpoch: 23 }));
    expect(html).toContain('Network volume share');
    expect(html).toContain('aria-label="Network volume share, epoch 22: 20.00%"');
    expect(html.match(/<svg /g)).toHaveLength(1);
    expect(html).toContain('left axis');
    expect(html).toContain('right axis');
    expect(html).toContain('>100%</text>');
    expect(html).not.toContain('View epoch data');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('epoch data table');
    expect(html).toContain('aria-label="Settled volume, epoch 22: 20 USDC"');
    const paths = [...html.matchAll(/<path d="([^"]*)"/g)].map(match => match[1]!);
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    for (const path of paths) {
      expect(path.match(/M/g)).toHaveLength(2);
      expect(path.match(/L/g)).toHaveLength(1);
    }
  });
  it('keeps the volume line when network share is unavailable', () => {
    const html = renderToStaticMarkup(createElement(PoolActivity, { volumes: [{ epoch: 22, usdc: '1000000' }], networkVolumes: [], currentEpoch: 23 }));
    expect(html.match(/<svg /g)).toHaveLength(1);
    expect(html).toContain('data-series="volume"');
    expect(html).not.toContain('data-series="share"');
    expect(html).toContain('Network share unavailable for these epochs.');
  });
});

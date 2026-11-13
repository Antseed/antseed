import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { DATA_SERVICES_METADATA_VERSION, METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import { buildNetworkServiceOffers, dataOfferUsdPerRequest, selectLowestPricedNetworkServiceOffer } from '../src/discovery/service-catalog.js';
import { supportsHealthProbe } from '../src/health/model-health-checker.js';

const perCall = (priceUsd: number) => ({ version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd }] });

/** A seller with a chat model and two data services, one of them free. */
function dataMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'openapi',
      services: ['kimi-k3', 'flights', 'open-data'],
      defaultPricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.45 },
      serviceCategories: { flights: ['travel', 'search'], 'kimi-k3': ['chat'] },
      serviceApiProtocols: {
        'kimi-k3': ['openai-chat-completions'],
        flights: ['openapi-data'],
        'open-data': ['openapi-data'],
      },
      serviceUnitBillingModels: {
        flights: { 'openapi-data': perCall(0.005) },
        'open-data': { 'openapi-data': { version: 1, components: [] } },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('data services in peer metadata', () => {
  it('is v18, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBe(18);
    expect(DATA_SERVICES_METADATA_VERSION).toBe(18);
    expect(SERVED_METADATA_VERSIONS).toContain(18);
    expect(negotiateMetadataVersion(18)).toBe(18);
    expect(negotiateMetadataVersion(17)).toBe(17);
    expect(negotiateMetadataVersion(16)).toBe(16);
    expect(negotiateMetadataVersion(15)).toBe(15);
  });

  it('round-trips data services and re-encodes to the same signed bytes', () => {
    const original = dataMetadata();
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(18);
    expect(decoded.providers[0]!.serviceApiProtocols?.['flights']).toEqual(['openapi-data']);
    const price = decoded.providers[0]!.serviceUnitBillingModels!['flights']!['openapi-data']!.components[0]!;
    expect(price.unit).toBe('completed_requests');
    expect(price.priceUsd).toBeCloseTo(0.005, 8);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  for (const version of [12, 13, 14, 15, 16, 17]) {
    it(`leaves data services out of the v${version} document so older buyers keep the rest of the seller`, () => {
      const older = getMetadataCodec(version).fromLatest(dataMetadata());
      expect(older.version).toBe(version);
      const provider = older.providers[0]!;
      expect(provider.services).toEqual(['kimi-k3']);
      expect(Object.keys(provider.serviceApiProtocols ?? {})).toEqual(['kimi-k3']);
      expect(provider.serviceUnitBillingModels).toBeUndefined();
      expect(Object.keys(provider.serviceCategories ?? {})).toEqual(['kimi-k3']);
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
      expect(decodeMetadata(encodeMetadata(older)).providers[0]!.services).toEqual(['kimi-k3']);
    });
  }

  it('drops a provider that only offers data from older documents', () => {
    const latest = dataMetadata();
    const provider = latest.providers[0]!;
    latest.providers = [{
      ...provider,
      services: ['flights'],
      serviceApiProtocols: { flights: ['openapi-data'] },
      serviceUnitBillingModels: { flights: provider.serviceUnitBillingModels!['flights']! },
      serviceCategories: undefined,
    }];
    expect(getMetadataCodec(17).fromLatest(latest).providers).toEqual([]);
  });

  it('refuses the data protocol in documents older than v18', () => {
    const older = { ...dataMetadata(), version: 17 };
    const messages = validateMetadata(older).map((error) => error.message);
    expect(messages).toContain('Service API protocol "openapi-data" requires metadata version 18');
  });

  it('lists data services as data offers priced per completed request', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['openapi'],
      providerServiceApiProtocols: { openapi: { services: { flights: ['openapi-data'], 'open-data': ['openapi-data'] } } },
      providerServiceCategories: { openapi: { services: { flights: ['travel'] } } },
      providerServiceUnitBillingModels: { openapi: { services: { flights: { 'openapi-data': perCall(0.005) }, 'open-data': { 'openapi-data': { version: 1, components: [] } } } } },
      providerPricing: { openapi: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } },
    }]);
    expect(offers.map((offer) => offer.serviceId).sort()).toEqual(['flights', 'open-data']);
    const flights = offers.find((offer) => offer.serviceId === 'flights')!;
    expect(flights).toMatchObject({ type: 'data', protocol: 'openapi-data', categories: ['travel'] });
    // Priced per request, never per token.
    expect(flights.inputUsdPerMillion).toBeUndefined();
    expect(dataOfferUsdPerRequest(flights)).toBe(0.005);
    expect(dataOfferUsdPerRequest(offers.find((offer) => offer.serviceId === 'open-data')!)).toBe(0);
    expect(selectLowestPricedNetworkServiceOffer(offers)?.serviceId).toBe('open-data');
  });

  it('still leaves routers and other completed-request services out of the catalog', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['irp-router', 'other'],
      providerServiceApiProtocols: { 'irp-router': { services: { router: ['irp-suggest'] } }, other: { services: { odd: ['openai-chat-completions'] } } },
      providerServiceUnitBillingModels: {
        'irp-router': { services: { router: { 'irp-suggest': perCall(0.001) } } },
        other: { services: { odd: { 'openai-chat-completions': perCall(0.001) } } },
      },
    }]);
    expect(offers).toEqual([]);
  });

  it('keeps a service that announces chat first and data second a text service', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      providers: ['openapi'],
      providerServiceApiProtocols: { openapi: { services: { both: ['openai-chat-completions', 'openapi-data'] } } },
      providerServiceUnitBillingModels: { openapi: { services: { both: { 'openapi-data': perCall(0.005) } } } },
      providerPricing: { openapi: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } } },
    }]);
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ serviceId: 'both', type: 'text', protocol: 'openai-chat-completions', inputUsdPerMillion: 1 });
    // It keeps its data price beside its token prices.
    expect(dataOfferUsdPerRequest(offers[0]!)).toBe(0.005);
  });

  it('does not probe data services: an operation is the seller\'s own and may cost it per call', () => {
    expect(supportsHealthProbe('openapi-data')).toBe(false);
  });
});

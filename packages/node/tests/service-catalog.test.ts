import { describe, expect, it } from 'vitest';
import { canonicalModelKey } from '../src/model-identity.js';
import {
  buildNetworkServiceOffers,
  selectLowestPricedCanonicalOffers,
  withServiceCatalogMemo,
  type NetworkServiceCatalogPeer,
} from '../src/discovery/service-catalog.js';

function peer(overrides: Partial<NetworkServiceCatalogPeer>): NetworkServiceCatalogPeer {
  return { peerId: 'a'.repeat(40), ...overrides };
}

describe('network service catalog', () => {
  const manyServices = () => peer({
    capabilities: ['verifier.antseed-verifier'],
    providerPricing: {
      alpha: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'Model-A': { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, 'model-b': { inputUsdPerMillion: 3, outputUsdPerMillion: 4 } } },
      beta: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: { 'model-a': { inputUsdPerMillion: 5, outputUsdPerMillion: 6 }, 'model-c': { inputUsdPerMillion: 7, outputUsdPerMillion: 8 } } },
    },
  });

  it('builds only the services asked for, and the same offers as building all of them and filtering', () => {
    const seller = manyServices();
    const all = buildNetworkServiceOffers([seller]);
    expect(all.map((offer) => `${offer.provider}/${offer.serviceId}`)).toEqual(['alpha/Model-A', 'alpha/model-b', 'beta/model-a', 'beta/model-c']);

    const built: string[] = [];
    const byModel = buildNetworkServiceOffers([seller], { modelKey: canonicalModelKey('model-a'), only: (provider, serviceId) => { built.push(`${provider}/${serviceId}`); return true; } });
    expect(byModel).toEqual(all.filter((offer) => offer.serviceId.toLowerCase() === 'model-a'));
    expect(built).toEqual(['alpha/Model-A', 'beta/model-a']);

    expect(buildNetworkServiceOffers([seller], { only: (provider) => provider === 'beta' })).toEqual(all.filter((offer) => offer.provider === 'beta'));
    expect(buildNetworkServiceOffers([seller], { modelKey: canonicalModelKey('unknown') })).toEqual([]);
    // Each offer owns its list: changing one must not change another seller-wide.
    expect(all[0]!.advertisedVerifierIds).not.toBe(all[1]!.advertisedVerifierIds);
  });

  it('gives the same offers inside a catalog memo, and forgets the sellers when it ends', () => {
    const seller = manyServices();
    const plain = buildNetworkServiceOffers([seller]);
    const inside = withServiceCatalogMemo(() => ({
      all: buildNetworkServiceOffers([seller]),
      again: buildNetworkServiceOffers([seller]),
      one: buildNetworkServiceOffers([seller], { modelKey: canonicalModelKey('model-a') }),
      nested: withServiceCatalogMemo(() => buildNetworkServiceOffers([seller], { modelKey: canonicalModelKey('model-c') })),
    }));
    expect(inside.all).toEqual(plain);
    expect(inside.again).toEqual(plain);
    expect(inside.one).toEqual(plain.filter((offer) => offer.serviceId.toLowerCase() === 'model-a'));
    expect(inside.nested.map((offer) => offer.serviceId)).toEqual(['model-c']);

    // A seller that announces something new afterwards is read afresh.
    seller.providerPricing!.alpha!.services!['model-d'] = { inputUsdPerMillion: 1, outputUsdPerMillion: 1 };
    expect(buildNetworkServiceOffers([seller], { modelKey: canonicalModelKey('model-d') }).map((offer) => offer.serviceId)).toEqual(['model-d']);
    expect(() => withServiceCatalogMemo(() => { throw new Error('stop'); })).toThrow('stop');
    expect(withServiceCatalogMemo(() => buildNetworkServiceOffers([seller]).length)).toBe(5);
  });

  it('excludes routing and completed-request APIs without hiding ordinary images', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['mixed'], services: ['route', 'summary', 'image'],
      providerServiceApiProtocols: { mixed: { services: { route: ['irp-suggest'], summary: ['typesafe-systemone'], image: ['openai-images'] } } },
      providerServiceUnitBillingModels: { mixed: { services: {
        summary: { 'typesafe-systemone': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } },
        image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
      } } },
    })]);
    expect(offers.map(offer => offer.serviceId)).toEqual(['image']);
    expect(offers[0]?.minImageUsdPerImage).toBe(0.04);
  });
  it('uses legacy services when provider pricing only announces defaults', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['openai'],
      services: ['gpt-4o'],
      providerPricing: {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
      },
    })]);

    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({
      provider: 'openai',
      serviceId: 'gpt-4o',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
    });
  });

  it('shows a service with its own price at the cached price it bills, not the default cached price', () => {
    const offers = buildNetworkServiceOffers([peer({
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 },
          services: { m: { inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.4 }, n: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 } },
        },
      },
      defaultCachedInputUsdPerMillion: 0.3,
    })]);

    const offer = (serviceId: string) => offers.find((candidate) => candidate.serviceId === serviceId);
    // Its cached input is billed at its own input price.
    expect(offer('m')).toMatchObject({ inputUsdPerMillion: 0.2, outputUsdPerMillion: 0.4 });
    expect(offer('m')?.cachedInputUsdPerMillion).toBeUndefined();
    expect(offer('n')).toMatchObject({ cachedInputUsdPerMillion: 0.1 });
  });

  it('shows a service priced by the defaults at the default cached price', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['openai'],
      services: ['gpt-4o'],
      providerPricing: { openai: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.3 } } },
    })]);
    expect(offers[0]).toMatchObject({ serviceId: 'gpt-4o', inputUsdPerMillion: 3, cachedInputUsdPerMillion: 0.3 });
  });

  it('does not assign every legacy service only to the first provider', () => {
    const offers = buildNetworkServiceOffers([peer({
      providers: ['anthropic', 'openai-responses'],
      services: ['claude-sonnet-4-5', 'gpt-5.6'],
    })]);

    expect(offers.map((offer) => ({
      provider: offer.provider,
      serviceId: offer.serviceId,
      protocol: offer.protocol,
    }))).toEqual([
      { provider: 'anthropic', serviceId: 'claude-sonnet-4-5', protocol: 'anthropic-messages' },
      { provider: 'anthropic', serviceId: 'gpt-5.6', protocol: 'anthropic-messages' },
      { provider: 'openai-responses', serviceId: 'claude-sonnet-4-5', protocol: 'openai-responses' },
      { provider: 'openai-responses', serviceId: 'gpt-5.6', protocol: 'openai-responses' },
    ]);
  });

  it('keeps the unrestricted service when a cheaper coding-only alias exists', () => {
    const offers = buildNetworkServiceOffers([peer({
      providerPricing: {
        anthropic: { services: { 'claude-opus-5': { inputUsdPerMillion: 5, outputUsdPerMillion: 25 } } },
        'claude-oauth': { services: { 'opus-5-coding-only': { inputUsdPerMillion: 1, outputUsdPerMillion: 5 } } },
      },
      providerServiceApiProtocols: {
        anthropic: { services: { 'claude-opus-5': ['anthropic-messages'] } },
        'claude-oauth': { services: { 'opus-5-coding-only': ['anthropic-messages'] } },
      },
    })]);

    const selected = selectLowestPricedCanonicalOffers(offers);
    expect(selected).toHaveLength(1);
    expect(selected[0]?.serviceId).toBe('claude-opus-5');
  });
});

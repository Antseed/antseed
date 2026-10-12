import { describe, expect, it } from 'vitest';
import { buildNetworkServiceOffers } from './service-catalog.js';

describe('buildNetworkServiceOffers', () => {
  it('projects peer-level verifier advertisements to every service offer', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'tee-seller', providers: ['openai'], services: ['model-a', 'model-b'],
      capabilities: ['verifier.antseed-verifier', 'verifier-default.antseed-verifier'],
    }, { peerId: 'legacy', providers: ['openai'], services: ['model-a'] }]);
    expect(offers.filter((offer) => offer.peerId === 'tee-seller').map((offer) => offer.advertisedVerifierIds))
      .toEqual([['antseed-verifier'], ['antseed-verifier']]);
    expect(offers.find((offer) => offer.peerId === 'legacy')?.advertisedVerifierIds).toEqual([]);
  });

  it('projects provider-specific services, pricing, protocols, and image billing', () => {
    const offers = buildNetworkServiceOffers([{
      peerId: 'a'.repeat(40),
      displayName: 'Seller',
      providers: ['openai', 'anthropic'],
      reputationScore: 90,
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          services: { 'gpt-image-test': {} },
        },
        anthropic: {
          services: { 'claude-test': { inputUsdPerMillion: 3, outputUsdPerMillion: 9 } },
        },
      },
      providerServiceApiProtocols: {
        openai: { services: { 'gpt-image-test': ['openai-images'] } },
        anthropic: { services: { 'claude-test': ['anthropic-messages'] } },
      },
      providerServiceCapabilities: {
        openai: { services: { 'gpt-image-test': { inputs: ['text'], outputs: ['image'] } } },
      },
      providerServiceUnitBillingModels: {
        openai: {
          services: {
            'gpt-image-test': {
              'openai-images': {
                version: 1,
                components: [
                  { unit: 'output_images', priceUsd: 0.04 },
                  { unit: 'output_images', priceUsd: 0.08 },
                ],
              },
            },
          },
        },
      },
    }]);

    expect(offers).toHaveLength(2);
    expect(offers.find((offer) => offer.serviceId === 'gpt-image-test')).toMatchObject({
      provider: 'openai',
      protocol: 'openai-images',
      type: 'image',
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 2,
      minImageUsdPerImage: 0.04,
      maxImageUsdPerImage: 0.08,
    });
    expect(offers.find((offer) => offer.serviceId === 'claude-test')).toMatchObject({
      provider: 'anthropic',
      protocol: 'anthropic-messages',
      type: 'text',
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 9,
    });
  });

  it('types typesafe-systemone services as decision offers', () => {
    expect(buildNetworkServiceOffers([{
      peerId: 'c'.repeat(40),
      providers: ['typesafe'],
      providerServiceApiProtocols: {
        typesafe: { services: { 'jev-latest': ['typesafe-systemone'] } },
      },
    }])).toMatchObject([{
      serviceId: 'jev-latest',
      provider: 'typesafe',
      protocol: 'typesafe-systemone',
      type: 'decision',
    }]);
  });

  it('supports legacy peer-wide service lists', () => {
    expect(buildNetworkServiceOffers([{
      peerId: 'b'.repeat(40),
      providers: ['openai'],
      services: ['legacy-model'],
    }])).toMatchObject([{
      serviceId: 'legacy-model',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      type: 'text',
    }]);
  });
});

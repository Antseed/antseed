import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import {
  MAX_SERVICE_API_PROTOCOLS_PER_SERVICE,
  MAX_SERVICES_PER_PROVIDER,
  validateMetadata,
} from '../src/discovery/metadata-validator.js';
import { bytesToHex } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';
import {
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_SIGNED_SDP_V1,
  CONNECTION_CAPABILITY_TCP_ENC_V1,
} from '../src/types/protocol.js';
import { METADATA_VERSION } from '../src/discovery/peer-metadata.js';
import { resolveServiceBillingOffer } from '@antseed/protocol/service-billing';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { verifySignature, hexToBytes } from '../src/p2p/identity.js';

function makeBaseConfig(): AnnouncerConfig {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const mockDht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const mockIdentity = {
    peerId,
    privateKey,
    wallet,
  };

  return {
    identity: mockIdentity,
    dht: mockDht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'openai',
        services: ['gpt-4.1'],
        maxConcurrency: 5,
      },
    ],
    region: 'us',
    pricing: new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]),
    reannounceIntervalMs: 60_000,
    signalingPort: 0,
  };
}

describe('PeerAnnouncer provider availability', () => {
  it('omits unavailable providers and restores them when they recover', async () => {
    let available = true;
    const announcer = new PeerAnnouncer({
      ...makeBaseConfig(),
      providers: [{
        provider: 'openai',
        services: ['model-a'],
        maxConcurrency: 4,
        isAvailable: () => available,
      }],
    });

    await announcer.announce();
    expect(announcer.getLatestMetadata()?.providers.map((provider) => provider.provider)).toEqual(['openai']);

    available = false;
    await announcer.refreshMetadata();
    const unavailableMetadata = announcer.getLatestMetadata();
    expect(unavailableMetadata?.providers).toEqual([]);
    expect(validateMetadata(unavailableMetadata!)).toEqual([]);

    available = true;
    await announcer.refreshMetadata();
    expect(announcer.getLatestMetadata()?.providers.map((provider) => provider.provider)).toEqual(['openai']);
  });
});

describe('PeerAnnouncer sellerContract', () => {
  it('publishes sellerContract in metadata as lowercase 40-hex', async () => {
    const base = makeBaseConfig();
    const proxy = '0x' + 'bb'.repeat(20);
    const announcer = new PeerAnnouncer({
      ...base,
      sellerContract: { sellerContract: proxy },
    });

    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBe('bb'.repeat(20));
  });

  it('omits sellerContract when not configured', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.sellerContract).toBeUndefined();
  });
});

describe('PeerAnnouncer capabilities', () => {
  it('publishes response auth support in metadata', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.capabilities).toEqual([
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
      CONNECTION_CAPABILITY_SIGNED_SDP_V1,
      CONNECTION_CAPABILITY_TCP_ENC_V1,
    ]);
  });

  it('publishes sweep relay support only when configured', async () => {
    const announcer = new PeerAnnouncer({
      ...makeBaseConfig(),
      relaysSweeps: true,
    });
    await announcer.announce();
    const meta = announcer.getLatestMetadata();
    expect(meta?.capabilities).toEqual([
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
      CONNECTION_CAPABILITY_SIGNED_SDP_V1,
      CONNECTION_CAPABILITY_TCP_ENC_V1,
      CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
    ]);
  });
});

describe('PeerAnnouncer metadata versions', () => {
  it('signs native completed-request and image models together in metadata v12', async () => {
    const offer = { provider: 'alpha', service: 'alpha-route', serviceApiProtocol: 'model-routing' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } };
    const announcer = new PeerAnnouncer({
      ...makeBaseConfig(),
      providers: [{ provider: 'images', services: ['image'], maxConcurrency: 5,
        serviceApiProtocols: { image: ['openai-images'] },
        serviceUnitBillingModels: { image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } } },
      }, { provider: offer.provider, services: [offer.service], maxConcurrency: 5,
        pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
        serviceApiProtocols: { [offer.service]: [offer.serviceApiProtocol] },
        serviceUnitBillingModels: { [offer.service]: { [offer.serviceApiProtocol]: { version: 1, components: [{ unit: 'completed_requests', priceUsd: offer.unitModel.components[0]!.priceUsd }] } } },
      }],
    });
    await announcer.announce();
    const metadata = announcer.getLatestMetadata()!;
    const decoded = decodeMetadata(encodeMetadata(metadata));
    expect(decoded.version).toBe(12);
    expect(decoded.offerings).toBeUndefined();
    expect(decoded.capabilities).toEqual([
      CONNECTION_CAPABILITY_RESPONSE_AUTH_V1,
      CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
      CONNECTION_CAPABILITY_SIGNED_SDP_V1,
      CONNECTION_CAPABILITY_TCP_ENC_V1,
    ].sort());
    expect(decoded.providers[0]?.services).toEqual(['image']);
    expect(decoded.providers[0]?.serviceUnitBillingModels?.image?.['openai-images']?.version).toBe(1);
    expect(resolveServiceBillingOffer(decoded.providers, offer.provider, offer.service)).toEqual({
      ...offer, unitModel: { version: 1, components: [{ unit: 'completed_requests', priceUsd: Math.fround(0.001) }] },
    });
    expect(await verifySignature(decoded.peerId, hexToBytes(decoded.signature), encodeMetadataForSigning(decoded))).toBe(true);
    const model = decoded.providers.find(provider => provider.provider === offer.provider)!.serviceUnitBillingModels![offer.service]![offer.serviceApiProtocol]!;
    model.components[0]!.priceUsd = 0.001001;
    expect(await verifySignature(decoded.peerId, hexToBytes(decoded.signature), encodeMetadataForSigning(decoded))).toBe(false);
  });
  it('announces current-version metadata carrying configured billing models', async () => {
    const base = makeBaseConfig();
    const announcer = new PeerAnnouncer({
      ...base,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': {
                version: 1,
                components: [{ unit: 'output_images', priceUsd: 0.04 }],
              },
            },
          },
          serviceCapabilities: {
            'gpt-image-1': { inputs: ['text'] },
            'unlisted-service': { contextWindow: 1000 },
          },
          maxConcurrency: 5,
        },
      ],
    });

    await announcer.announce();

    const metadata = announcer.getLatestMetadata();
    expect(metadata?.version).toBe(METADATA_VERSION);
    expect(metadata?.providers[0]?.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']).toEqual({
      version: 1,
      components: [{ unit: 'output_images', priceUsd: 0.04 }],
    });
    // Capabilities for services outside providers[].services are dropped.
    expect(metadata?.providers[0]?.serviceCapabilities).toEqual({
      'gpt-image-1': { inputs: ['text'] },
    });
  });

  it('announces current-version metadata without billing models when none are configured', async () => {
    const announcer = new PeerAnnouncer(makeBaseConfig());
    await announcer.announce();

    const metadata = announcer.getLatestMetadata();
    expect(metadata?.version).toBe(METADATA_VERSION);
    expect(metadata?.providers[0]?.serviceUnitBillingModels).toBeUndefined();
  });
});

describe('PeerAnnouncer metadata limits', () => {
  it('accepts the maximum service catalog size', async () => {
    const config = makeBaseConfig();
    config.providers = [{
      provider: 'openai',
      services: Array.from({ length: MAX_SERVICES_PER_PROVIDER }, (_, index) => `service-${index}`),
      maxConcurrency: 5,
    }];

    const announcer = new PeerAnnouncer(config);
    await expect(announcer.announce()).resolves.toBeUndefined();
    expect(announcer.getLatestMetadata()?.providers[0]?.services).toHaveLength(MAX_SERVICES_PER_PROVIDER);
  });

  it('rejects a seller catalog above the service limit', async () => {
    const config = makeBaseConfig();
    config.providers = [{
      provider: 'openai',
      services: Array.from({ length: MAX_SERVICES_PER_PROVIDER + 1 }, (_, index) => `service-${index}`),
      maxConcurrency: 5,
    }];

    const announcer = new PeerAnnouncer(config);
    await expect(announcer.announce()).rejects.toThrow(
      `Service count ${MAX_SERVICES_PER_PROVIDER + 1} exceeds max ${MAX_SERVICES_PER_PROVIDER}`,
    );
  });

  it('rejects a seller service above the protocol limit', async () => {
    const config = makeBaseConfig();
    config.providers = [{
      provider: 'openai',
      services: ['multi-protocol'],
      serviceApiProtocols: {
        'multi-protocol': [
          'anthropic-messages',
          'openai-chat-completions',
          'openai-completions',
          'openai-responses',
          'openai-images',
        ],
      },
      maxConcurrency: 5,
    }];

    const announcer = new PeerAnnouncer(config);
    await expect(announcer.announce()).rejects.toThrow(
      `Service API protocol count ${MAX_SERVICE_API_PROTOCOLS_PER_SERVICE + 1} exceeds max ${MAX_SERVICE_API_PROTOCOLS_PER_SERVICE}`,
    );
  });

  it('rejects an encoded seller announcement above the byte limit', async () => {
    const config = makeBaseConfig();
    const services = Array.from({ length: MAX_SERVICES_PER_PROVIDER }, (_, index) => `service-${index}`);
    const serviceCategories = Object.fromEntries(
      services.map((service, serviceIndex) => [
        service,
        Array.from({ length: 64 }, (_, categoryIndex) => `c-${serviceIndex}-${categoryIndex}`),
      ]),
    );
    config.providers = [{
      provider: 'openai',
      services,
      serviceCategories,
      maxConcurrency: 5,
    }];

    const announcer = new PeerAnnouncer(config);
    await expect(announcer.announce()).rejects.toThrow(/Encoded size \d+ exceeds max 131072/);
  });
});

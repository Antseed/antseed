import { UNIT_BILLING_UNIT_IDS_V1 } from '../src/types/billing.js';
import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata, encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, SERVICE_CAPABILITIES_METADATA_VERSION, SERVICE_UNIT_BILLING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

function makeMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus', 'claude-3-sonnet'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        servicePricing: {
          'claude-3-opus': {
            inputUsdPerMillion: 18,
            outputUsdPerMillion: 90,
          },
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(130),
    ...overrides,
  };
}

describe('encodeMetadata / decodeMetadata', () => {
  it('round-trips signed video options in v12', () => {
    const metadata = makeMetadata({ version: 12 });
    const video = { durationsSeconds: [5, 10], resolutions: ['720p', '1080p'], aspectRatios: ['16:9', '9:16'], inputs: ['first_frame', 'last_frame'] as const, requiredInputs: ['first_frame'] as const, audio: false };
    metadata.providers[0]!.serviceCapabilities = { video: { outputs: ['video'], video: { ...video, inputs: [...video.inputs], requiredInputs: [...video.requiredInputs] } } };
    expect(decodeMetadata(encodeMetadata(metadata)).providers[0]!.serviceCapabilities?.video?.video).toEqual(metadata.providers[0]!.serviceCapabilities.video!.video);
    expect(decodeMetadata(encodeMetadata(metadata)).version).toBe(12);
    const changed = structuredClone(metadata);
    changed.providers[0]!.serviceCapabilities!.video!.video!.durationsSeconds = [5];
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(metadata));
  });
  it('preserves the existing non-video v12 wire format', () => {
    const metadata = makeMetadata({
      version: 12,
      region: 'us',
      providers: [{
        provider: 'test', services: ['text'],
        defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
        serviceCapabilities: { text: {
          inputs: ['text'], outputs: ['text'], reasoning: false,
          toolUse: true, supportedParameters: ['temperature'],
        } },
        maxConcurrency: 1, currentLoad: 0,
      }],
    });
    const legacyBytes = Buffer.from(
      '0caaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa0275730000018bcfe5680001047465737400010474657874000000000000000000000000000000000000000000010474657874dc010102010b74656d706572617475726500010000000000000000000000' + 'bb'.repeat(65),
      'hex',
    );

    expect(Buffer.from(encodeMetadata(metadata))).toEqual(legacyBytes);
    expect(decodeMetadata(legacyBytes).providers[0]!.serviceCapabilities).toEqual(metadata.providers[0]!.serviceCapabilities);
  });
  it('round-trips mixed video and non-video entries without losing empty options', () => {
    const metadata = makeMetadata({ version: 12 });
    metadata.providers[0]!.serviceCapabilities = {
      alpha: { video: { audio: true }, supportedParameters: ['seed'] },
      beta: { video: {} },
      gamma: { inputs: ['text'], toolUse: false },
    };

    const decoded = decodeMetadata(encodeMetadata(metadata));
    expect(decoded.providers[0]!.serviceCapabilities).toEqual(metadata.providers[0]!.serviceCapabilities);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(metadata));
  });
  it('round-trips native video protocols and appended billing units without changing image IDs', () => {
    const metadata = makeMetadata();
    const provider = metadata.providers[0]!;
    provider.serviceApiProtocols = { video: ['venice-video'] };
    provider.serviceUnitBillingModels = { video: {
      'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.25 }] },
    } };
    const decoded = decodeMetadata(encodeMetadata(metadata));
    expect(decoded.providers[0]?.serviceApiProtocols).toEqual(provider.serviceApiProtocols);
    expect(decoded.providers[0]?.serviceUnitBillingModels).toEqual(provider.serviceUnitBillingModels);
  });
  it.each([
    ['anthropic-messages', 0], ['openai-chat-completions', 1], ['openai-completions', 2],
    ['openai-responses', 3], ['openai-images', 4], ['typesafe-systemone', 5],
    ['venice-video', 11],
  ] as const)('preserves the billing wire ID for %s', (protocol, wireId) => {
    const metadata = makeMetadata();
    const marker = 'billing-wire-id';
    metadata.providers[0]!.serviceUnitBillingModels = { [marker]: { [protocol]: { version: 1, components: [] } } };
    const bytes = Buffer.from(encodeMetadata(metadata));
    const offset = bytes.indexOf(marker);
    expect(offset).toBeGreaterThan(0);
    expect(bytes[offset + marker.length]).toBe(wireId);
    expect(decodeMetadata(bytes).providers[0]!.serviceUnitBillingModels).toEqual(metadata.providers[0]!.serviceUnitBillingModels);
  });

  it('round-trips v12 catalogs with more than 255 service entries', () => {
    const services = Array.from({ length: 300 }, (_, index) => `service-${index}`);
    const servicePricing = Object.fromEntries(
      services.map((service) => [service, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }]),
    );
    const serviceCategories = Object.fromEntries(services.map((service) => [service, ['chat']]));
    const serviceApiProtocols = Object.fromEntries(
      services.map((service) => [service, ['openai-images'] as const]),
    );
    const serviceUnitBillingModels = Object.fromEntries(
      services.map((service) => [service, {
        'openai-images': {
          version: 1 as const,
          components: [{ unit: 'output_images' as const, priceUsd: 0.04 }],
        },
      }]),
    );
    const serviceCapabilities = Object.fromEntries(
      services.map((service) => [service, { inputs: ['text'] as const }]),
    );
    const original = makeMetadata({
      providers: [{
        provider: 'openai',
        services,
        defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        servicePricing,
        serviceCategories,
        serviceApiProtocols,
        serviceUnitBillingModels,
        serviceCapabilities,
        maxConcurrency: 10,
        currentLoad: 0,
      }],
    });

    const decoded = decodeMetadata(encodeMetadata(original));

    expect(decoded.version).toBe(METADATA_VERSION);
    expect(decoded.providers[0]?.services).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.servicePricing ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceCategories ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceApiProtocols ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceUnitBillingModels ?? {})).toHaveLength(300);
    expect(Object.keys(decoded.providers[0]?.serviceCapabilities ?? {})).toHaveLength(300);
  });

  it('should round-trip a basic metadata object', () => {
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.version).toBe(original.version);
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.signature).toBe(original.signature);
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
    expect(decoded.providers[0]!.services).toEqual(['claude-3-opus', 'claude-3-sonnet']);
    expect(decoded.providers[0]!.maxConcurrency).toBe(10);
    expect(decoded.providers[0]!.currentLoad).toBe(3);
  });

  it('should handle float32 precision for prices', () => {
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);
    // Float32 has limited precision — allow small delta
    expect(decoded.providers[0]!.defaultPricing.inputUsdPerMillion).toBeCloseTo(15, 3);
    expect(decoded.providers[0]!.defaultPricing.outputUsdPerMillion).toBeCloseTo(75, 3);
    expect(decoded.providers[0]!.servicePricing?.['claude-3-opus']?.inputUsdPerMillion).toBeCloseTo(18, 3);
    expect(decoded.providers[0]!.servicePricing?.['claude-3-opus']?.outputUsdPerMillion).toBeCloseTo(90, 3);
  });

  it('should round-trip multiple providers', () => {
    const original = makeMetadata({
      providers: [
        {
          provider: 'openai',
          services: ['gpt-4'],
          defaultPricing: {
            inputUsdPerMillion: 10,
            outputUsdPerMillion: 30,
          },
          maxConcurrency: 5,
          currentLoad: 0,
        },
        {
          provider: 'anthropic',
          services: ['claude-3-haiku'],
          defaultPricing: {
            inputUsdPerMillion: 1,
            outputUsdPerMillion: 5,
          },
          servicePricing: {
            'claude-3-haiku': {
              inputUsdPerMillion: 0.9,
              outputUsdPerMillion: 4.5,
            },
          },
          maxConcurrency: 20,
          currentLoad: 10,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers).toHaveLength(2);
    expect(decoded.providers[0]!.provider).toBe('openai');
    expect(decoded.providers[1]!.provider).toBe('anthropic');
  });

  it('should round-trip zero providers', () => {
    const original = makeMetadata({ providers: [] });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers).toHaveLength(0);
  });

  it('should round-trip empty services list', () => {
    const original = makeMetadata({
      providers: [
        {
          provider: 'test',
          services: [],
          defaultPricing: {
            inputUsdPerMillion: 0,
            outputUsdPerMillion: 0,
          },
          maxConcurrency: 1,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.services).toEqual([]);
  });

  it('should round-trip display name, service categories, and service API protocols', () => {
    const original = makeMetadata({
      displayName: 'Node A',
      publicAddress: 'peer.example.com:6882',
      providers: [
        {
          provider: 'anthropic',
          services: ['claude-3-opus'],
          defaultPricing: {
            inputUsdPerMillion: 15,
            outputUsdPerMillion: 75,
          },
          serviceCategories: {
            'claude-3-opus': ['privacy', 'coding'],
          },
          serviceApiProtocols: {
            'claude-3-opus': ['openai-chat-completions', 'anthropic-messages'],
          },
          maxConcurrency: 10,
          currentLoad: 3,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.displayName).toBe('Node A');
    expect(decoded.publicAddress).toBe('peer.example.com:6882');
    expect(decoded.providers[0]!.serviceCategories?.['claude-3-opus']).toEqual(['coding', 'privacy']);
    expect(decoded.providers[0]!.serviceApiProtocols?.['claude-3-opus']).toEqual(['anthropic-messages', 'openai-chat-completions']);
  });

  it('encodes billing units by their canonical positions', () => {
    const units = ['output_images', 'completed_requests', 'video_generations', 'video_seconds'] as const;
    const encodedIds = units.map((unit) => {
      const metadata = makeMetadata({
        version: SERVICE_UNIT_BILLING_METADATA_VERSION,
        providers: [{
          provider: 'future',
          services: ['svc'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceUnitBillingModels: {
            svc: { 'openai-images': { version: 1, components: [{ unit, priceUsd: 0.25 }] } },
          },
          maxConcurrency: 1,
          currentLoad: 0,
        }],
      });
      const encoded = encodeMetadata(metadata);
      expect(decodeMetadata(encoded).providers[0]!.serviceUnitBillingModels?.svc?.['openai-images']?.components[0]?.unit).toBe(unit);
      const entryPrefix = [3, 115, 118, 99, 4, 1, 1];
      const entryOffset = encoded.findIndex((_, index) => (
        entryPrefix.every((byte, relativeIndex) => encoded[index + relativeIndex] === byte)
      ));
      expect(entryOffset).toBeGreaterThanOrEqual(0);
      return encoded[entryOffset + entryPrefix.length];
    });

    expect(encodedIds).toEqual([0, 1, 2, 3]);
  });

  it('round-trips v11 service unit billing models and signs billing bytes', () => {
    const original = makeMetadata({
      version: SERVICE_UNIT_BILLING_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': {
                version: 1,
                components: [
                  { unit: 'output_images', priceUsd: 0.04, match: { size: '1024x1024' } },
                ],
              },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.components).toHaveLength(1);
    expect(decoded.providers[0]!.serviceUnitBillingModels?.['gpt-image-1']?.['openai-images']?.components[0]?.priceUsd).toBeCloseTo(0.04, 5);

    const changed = makeMetadata({
      ...original,
      providers: [{
        ...original.providers[0]!,
        serviceUnitBillingModels: {
          'gpt-image-1': {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.05 }],
            },
          },
        },
      }],
    });
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(original));
  });

  it('round-trips v12 service capabilities and signs capability bytes', () => {
    const original = makeMetadata({
      version: SERVICE_CAPABILITIES_METADATA_VERSION,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-5.5', 'gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceCapabilities: {
            'gpt-5.5': {
              contextWindow: 200_000,
              maxOutputTokens: 16_384,
              inputs: ['text', 'image'],
              reasoning: true,
              toolUse: false,
            },
            'gpt-image-1': {
              inputs: ['text'],
              outputs: ['image'],
              // Deliberately unsorted: the codec canonicalizes to code-unit order.
              supportedParameters: ['size', 'background', 'quality', 'output_format'],
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-5.5']).toEqual({
      contextWindow: 200_000,
      maxOutputTokens: 16_384,
      inputs: ['text', 'image'],
      reasoning: true,
      toolUse: false,
    });
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-5.5']?.structuredOutput).toBeUndefined();
    expect(decoded.providers[0]!.serviceCapabilities?.['gpt-image-1']).toEqual({
      inputs: ['text'],
      outputs: ['image'],
      supportedParameters: ['background', 'output_format', 'quality', 'size'],
    });
    // Decoded metadata re-encodes to the same bytes, so signatures verify.
    expect(encodeMetadataForSigning({ ...decoded, signature: original.signature }))
      .toEqual(encodeMetadataForSigning(original));

    const changed = makeMetadata({
      ...original,
      providers: [{
        ...original.providers[0]!,
        serviceCapabilities: {
          ...original.providers[0]!.serviceCapabilities,
          'gpt-5.5': { contextWindow: 128_000 },
        },
      }],
    });
    expect(encodeMetadataForSigning(changed)).not.toEqual(encodeMetadataForSigning(original));
  });

  it('excludes service capabilities from v10 metadata bytes', () => {
    const original = makeMetadata({
      version: 10,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-5.5'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceCapabilities: { 'gpt-5.5': { contextWindow: 200_000 } },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });

    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(10);
    expect(decoded.providers[0]?.serviceCapabilities).toBeUndefined();
  });

  it('excludes service unit billing models from v10 metadata bytes', () => {
    const original = makeMetadata({
      version: 10,
      providers: [
        {
          provider: 'openai',
          services: ['gpt-image-1'],
          defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
          serviceApiProtocols: { 'gpt-image-1': ['openai-images'] },
          serviceUnitBillingModels: {
            'gpt-image-1': {
              'openai-images': {
                version: 1,
                components: [{ unit: 'output_images', priceUsd: 0.04 }],
              },
            },
          },
          maxConcurrency: 3,
          currentLoad: 0,
        },
      ],
    });

    const decoded = decodeMetadata(encodeMetadata(original));

    expect(decoded.version).toBe(10);
    expect(decoded.providers[0]?.serviceApiProtocols?.['gpt-image-1']).toEqual(['openai-images']);
    expect(decoded.providers[0]?.serviceUnitBillingModels).toBeUndefined();
  });

  it('should decode offerings and optional trailer fields after v2 provider pricing payload', () => {
    const original = makeMetadata({
      offerings: [
        {
          capability: 'skill',
          name: 'summarize',
          description: 'Summarize text',
          pricing: { unit: 'request', pricePerUnit: 0.1, currency: 'USD' },
          services: ['claude-3-sonnet'],
        },
      ],
      onChainChannelCount: 123,
      onChainGhostCount: 2,
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.offerings?.[0]?.name).toBe('summarize');
    expect(decoded.onChainChannelCount).toBe(123);
    expect(decoded.onChainGhostCount).toBe(2);
  });

  it("round-trips a v8 metadata with sellerContract", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: 8,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      sellerContract: "bb".repeat(20),
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.sellerContract).toEqual(meta.sellerContract);
  });

  it("round-trips v8 metadata with no sellerContract", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: 8,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.sellerContract).toBeUndefined();
  });

  it("round-trips domain verification claims", () => {
    const original = makeMetadata({
      verifications: {
        domains: [
          { domain: "example.com", methods: ["https-well-known", "dns-txt"] },
          { domain: "api.example.com" },
        ],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      domains: [
        { domain: "api.example.com" },
        { domain: "example.com", methods: ["dns-txt", "https-well-known"] },
      ],
    });
  });

  it("round-trips github verification claims", () => {
    const original = makeMetadata({
      verifications: {
        github: [
          { username: "Octocat", repository: "Proofs" },
          { username: "hubber" },
        ],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      github: [
        { username: "hubber" },
        { username: "octocat", repository: "proofs" },
      ],
    });
  });

  it("round-trips combined domain and github verification claims", () => {
    const original = makeMetadata({
      verifications: {
        domains: [{ domain: "example.com", methods: ["dns-txt"] }],
        github: [{ username: "octocat" }],
      },
    });
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.verifications).toEqual({
      domains: [{ domain: "example.com", methods: ["dns-txt"] }],
      github: [{ username: "octocat" }],
    });
  });

  it("round-trips v10 metadata with peer capabilities", () => {
    const meta: PeerMetadata = {
      peerId: "aa".repeat(20),
      version: METADATA_VERSION,
      region: "us-east-1",
      timestamp: 1_700_000_000_000,
      providers: [],
      capabilities: ["verification.response-auth.v1"],
      signature: "dd".repeat(65),
    };
    const bytes = encodeMetadata(meta);
    const decoded = decodeMetadata(bytes);
    expect(decoded.capabilities).toEqual(["verification.response-auth.v1"]);
  });

  // v2/v3/v4/v5 roundtrip tests removed — pre-v6 format is rejected by the decoder.
});

describe('encodeMetadataForSigning', () => {
  it('should produce a shorter buffer than encodeMetadata (no signature)', () => {
    const metadata = makeMetadata();
    const forSigning = encodeMetadataForSigning(metadata);
    const full = encodeMetadata(metadata);
    // Full includes 65 bytes of signature (EVM secp256k1 r+s+v)
    expect(full.length).toBe(forSigning.length + 65);
  });

  it('should produce deterministic output for the same input', () => {
    const metadata = makeMetadata();
    const a = encodeMetadataForSigning(metadata);
    const b = encodeMetadataForSigning(metadata);
    expect(a).toEqual(b);
  });
});

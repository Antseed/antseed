import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec } from '../src/discovery/metadata-codec.js';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

// Every field v10-v12 know. The hashes are of the bytes the codec signed
// before it was split into per-version files: buyers that have not upgraded
// verify those exact bytes, so they must never change.
const fixture = (version: number): PeerMetadata => {
  const metadata = {
    peerId: "ab".repeat(20), version: 12, region: "eu-west-1", timestamp: 1_700_000_000_000,
    displayName: "Seller Ü", publicAddress: "1.2.3.4:6882", sellerContract: "cd".repeat(20),
    capabilities: ["tcp-enc.v1", "signed-sdp.v1"],
    onChainChannelCount: 12, onChainGhostCount: 3,
    verifications: { domains: [{ domain: "example.com", methods: ["dns-txt"] }], github: [{ username: "foo", repository: "bar" }] },
    offerings: [{ capability: "inference", name: "x", description: "d", services: ["m1"], pricing: { unit: "token", pricePerUnit: 1.5, currency: "USD" } }],
    providers: [{
      provider: "openai", services: ["m1", "m2", "vid", "img"],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5 },
      servicePricing: { m2: { inputUsdPerMillion: 3, outputUsdPerMillion: 4, cachedInputUsdPerMillion: 1 } },
      serviceCategories: { m1: ["coding", "chat"], m2: ["privacy"] },
      serviceApiProtocols: { m1: ["openai-chat-completions", "anthropic-messages"], img: ["openai-images"] },
      serviceUnitBillingModels: { img: { "openai-images": { version: 1, components: [{ unit: "output_images", priceUsd: 0.04 }] } } },
      serviceCapabilities: { m1: { contextWindow: 200000, maxOutputTokens: 8000, inputs: ["text", "image"], reasoning: true, toolUse: true, structuredOutput: false, supportedParameters: ["seed"] },
        vid: { video: { durationsSeconds: [5, 10], resolutions: ["720p"], aspectRatios: ["16:9"], audio: true } } },
      maxConcurrency: 8, currentLoad: 2,
    }, { provider: "anthropic", services: [], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0 }],
    signature: "",
  } as any;
  metadata.version = version;
  if (version < 12) {
    metadata.providers = metadata.providers.map((provider: any) => {
      const { serviceCapabilities: _capabilities, ...rest } = provider;
      if (version < 11) delete rest.serviceUnitBillingModels;
      return rest;
    });
  }
  return metadata as PeerMetadata;
};

const GOLDEN_SHA256: Record<number, string> = {
  10: '27b3c5f031f632d8a6eef35c00bd70dcc7dbdc0adbff17f55a956c5a790ed252',
  11: '8bd42ef2d8fd886b718c42800ef0573c63230cff0a111573db1945ea43f96bb2',
  12: 'a5dbd0ef1380cfe1bd9ed16586540de4600c41039d3eb0e76b9758211b084a3d',
};

describe('metadata signing bytes', () => {
  for (const [version, hash] of Object.entries(GOLDEN_SHA256)) {
    it(`keeps the v${version} signed bytes`, () => {
      expect(createHash('sha256').update(encodeMetadataForSigning(fixture(Number(version)))).digest('hex')).toBe(hash);
    });
  }

  it('serves old buyers a v12 document without failing services, still listing a wildcard provider', () => {
    const latest = fixture(13);
    latest.providers[0]!.serviceHealth = { m1: { status: 'failing', reason: 'timeout' }, m2: { status: 'healthy' } };
    latest.providers[1]!.serviceHealth = undefined;
    const legacy = getMetadataCodec(12).fromLatest(latest);
    expect(legacy.providers.map((provider) => [provider.provider, provider.services])).toEqual([
      ['openai', ['m2', 'vid', 'img']],
      ['anthropic', []],
    ]);
    expect(legacy.providers[0]!.serviceHealth).toBeUndefined();
  });

  it('round-trips service names that collide with Object.prototype', () => {
    const latest = fixture(13);
    const odd = JSON.parse('{"__proto__": {"status": "failing", "reason": "timeout"}, "constructor": {"status": "healthy"}}');
    latest.providers[0]!.services = [...latest.providers[0]!.services, '__proto__', 'constructor'];
    latest.providers[0]!.serviceHealth = odd;
    latest.signature = 'ab'.repeat(65);
    const bytes = encodeMetadataForSigning(latest);
    const decoded = decodeMetadata(encodeMetadata(latest));
    expect(Object.keys(decoded.providers[0]!.serviceHealth ?? {})).toEqual(['__proto__', 'constructor']);
    expect(encodeMetadataForSigning(decoded)).toEqual(bytes);
  });
});

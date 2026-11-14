import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { encodeMetadataForSigning, getMetadataCodec } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { DEFAULT_LOOKUP_CONFIG, PeerLookup } from '../src/discovery/peer-lookup.js';
import { DHTNode } from '../src/discovery/dht-node.js';
import { signData, verifySignature } from '../src/p2p/identity.js';
import { hexToBytes } from '@antseed/protocol/signing';
import type { PeerMetadata } from '../src/discovery/peer-metadata.js';

// Signed metadata service maps are ordered with the signing host's historical
// locale-sensitive `localeCompare` sort. Because that order changes with the
// host's ICU collation, a buyer re-encoding the JSON it received could build a
// signing body that is a byte permutation of the one the seller signed — same
// length, same bytes, different order — and reject otherwise valid signatures
// (issue #1678: a Windows host with Thai collation rejected every signature
// from a seller whose host collation matched code-unit order for these names).
//
// Sellers keep signing with the historical ordering, so existing signed bytes
// and legacy seller/buyer pairs are unchanged. Buyers now verify against both
// the historical ordering and a deterministic code-unit ordering of the same
// document; each candidate is a genuine ecrecover check against the expected
// peer identity.

// Synthetic service names whose code-unit and Thai-collation ordering differ.
// Code-unit: hyphen (0x2d) sorts before dot (0x2e) and uppercase before
// lowercase; the Thai collation ignores punctuation and orders digits before
// letters, flipping the pairs below.
const SERVICE_PRICING = {
  'test-1.1-alpha': { inputUsdPerMillion: 1.1, outputUsdPerMillion: 2.2, cachedInputUsdPerMillion: 0.1 },
  'test-1-beta': { inputUsdPerMillion: 1.2, outputUsdPerMillion: 2.4, cachedInputUsdPerMillion: 0.2 },
  'test-2.5-gamma': { inputUsdPerMillion: 2.5, outputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.25 },
  'test-2-6-delta': { inputUsdPerMillion: 2.6, outputUsdPerMillion: 5.2, cachedInputUsdPerMillion: 0.26 },
  T1: { inputUsdPerMillion: 3, outputUsdPerMillion: 6, cachedInputUsdPerMillion: 0.3 },
  t1: { inputUsdPerMillion: 3.1, outputUsdPerMillion: 6.2, cachedInputUsdPerMillion: 0.31 },
};
const CODE_UNIT_ORDER = [
  'T1', 't1', 'test-1-beta', 'test-1.1-alpha', 'test-2-6-delta', 'test-2.5-gamma',
];
const CODE_UNIT_UNIT_BILLING_ORDER = ['test-1.1-alpha', 'test-2.5-gamma'];

function doc(version: number, peerId = 'ab'.repeat(20)): PeerMetadata {
  return {
    peerId,
    version,
    region: 'test-region-1',
    timestamp: 1_700_000_000_000,
    displayName: 'synthetic-test-seller',
    publicAddress: '203.0.113.10:16882',
    verifications: { domains: [{ domain: 'example.com', methods: ['dns-txt'] }] },
    capabilities: ['tcp-enc.v1', 'signed-sdp.v1'],
    onChainChannelCount: 12,
    onChainGhostCount: 3,
    providers: [{
      provider: 'example-provider',
      services: Object.keys(SERVICE_PRICING),
      maxConcurrency: 8,
      currentLoad: 2,
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.5 },
      servicePricing: SERVICE_PRICING,
      serviceCategories: {
        'test-1.1-alpha': ['chat'], 'test-1-beta': ['chat'],
        'test-2.5-gamma': ['coding'], 'test-2-6-delta': ['coding'],
      },
      serviceApiProtocols: Object.fromEntries(Object.keys(SERVICE_PRICING).map(k => [
        k,
        (k === 'test-1.1-alpha' || k === 'test-2.5-gamma')
          ? ['openai-chat-completions', 'openai-images']
          : ['openai-chat-completions'],
      ])),
      serviceUnitBillingModels: {
        'test-1.1-alpha': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
        'test-2.5-gamma': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } },
      },
    }],
    signature: '',
  } as unknown as PeerMetadata;
}

function loadFixture(version: 12 | 17): PeerMetadata {
  return JSON.parse(readFileSync(
    fileURLToPath(new URL(`./fixtures/metadata-locale-determinism-v${version}.json`, import.meta.url)),
    'utf8',
  )) as PeerMetadata;
}

function lookup(): PeerLookup {
  return new PeerLookup({
    ...DEFAULT_LOOKUP_CONFIG,
    dht: new DHTNode({ peerId: '00'.repeat(20), port: 0, bootstrapNodes: [] }),
  });
}

describe('signed service-map ordering', () => {
  for (const version of [12, 17] as const) {
    it(`writes code-unit order when the verifier requests it (v${version})`, () => {
      const body = encodeMetadataForSigning(doc(version), { serviceOrder: 'code-unit' });
      const decoded = getMetadataCodec(version).decode(
        (() => {
          const withSignature = new Uint8Array(body.length + 65);
          withSignature.set(body, 0);
          return withSignature;
        })(),
      );
      const provider = decoded.providers[0]!;
      expect(Object.keys(provider.servicePricing ?? {})).toEqual(CODE_UNIT_ORDER);
      expect(Object.keys(provider.serviceCategories ?? {}))
        .toEqual(CODE_UNIT_ORDER.filter(name => name !== 'T1' && name !== 't1'));
      expect(Object.keys(provider.serviceApiProtocols ?? {})).toEqual(CODE_UNIT_ORDER);
      expect(Object.keys(provider.serviceUnitBillingModels ?? {})).toEqual(CODE_UNIT_UNIT_BILLING_ORDER);
    });

    it(`keeps the historical host-localeCompare order by default (v${version})`, () => {
      const body = encodeMetadataForSigning(doc(version));
      const legacyOrder = Object.keys(SERVICE_PRICING).sort((a, b) => a.localeCompare(b));
      const decoded = getMetadataCodec(version).decode(
        (() => {
          const withSignature = new Uint8Array(body.length + 65);
          withSignature.set(body, 0);
          return withSignature;
        })(),
      );
      expect(Object.keys(decoded.providers[0]!.servicePricing ?? {})).toEqual(legacyOrder);
    });

    it(`re-encodes byte-identically after a JSON round-trip (v${version})`, () => {
      const metadata = doc(version);
      const signedBytes = encodeMetadataForSigning(metadata, { serviceOrder: 'code-unit' });
      const reserialized = JSON.parse(JSON.stringify(metadata)) as PeerMetadata;
      expect(encodeMetadataForSigning(reserialized, { serviceOrder: 'code-unit' })).toEqual(signedBytes);
    });
  }

  it('produces distinct legacy and code-unit bodies for collation-sensitive names', () => {
    const metadata = doc(17);
    const legacy = encodeMetadataForSigning(metadata);
    const canonical = encodeMetadataForSigning(metadata, { serviceOrder: 'code-unit' });
    expect(legacy.length).toBe(canonical.length);
    expect(Buffer.from(legacy).equals(Buffer.from(canonical))).toBe(false);
  });

  it('verifies a legacy same-locale signature', async () => {
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const metadata = doc(17, wallet.address.slice(2).toLowerCase());
    const signature = signData(wallet, encodeMetadataForSigning(metadata));
    metadata.signature = Buffer.from(signature).toString('hex');
    expect(verifySignature(metadata.peerId, signature, encodeMetadataForSigning(metadata))).toBe(true);
    expect(await lookup().verifyMetadataSignature(metadata)).toBe(true);
  });

  it('verifies a code-unit signature through the compatibility candidate', async () => {
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const metadata = doc(17, wallet.address.slice(2).toLowerCase());
    const signature = signData(wallet, encodeMetadataForSigning(metadata, { serviceOrder: 'code-unit' }));
    metadata.signature = Buffer.from(signature).toString('hex');
    expect(await lookup().verifyMetadataSignature(metadata)).toBe(true);
  });
});

describe('issue #1678 regression: synthetic seller fixtures verify', () => {
  for (const version of [12, 17] as const) {
    it(`verifies the synthetic v${version} seller response`, async () => {
      const metadata = loadFixture(version);
      expect(metadata.version).toBe(version);
      expect(metadata.peerId).toMatch(/^[0-9a-f]{40}$/);
      expect(validateMetadata(metadata)).toEqual([]);
      expect(await lookup().verifyMetadataSignature(metadata)).toBe(true);
    });

    it(`rejects tampered v${version} bodies and signatures`, () => {
      const metadata = loadFixture(version);
      const body = encodeMetadataForSigning(metadata);
      const flippedBody = Uint8Array.from(body);
      flippedBody[flippedBody.length - 1] ^= 0x01;
      expect(verifySignature(metadata.peerId, hexToBytes(metadata.signature!), flippedBody)).toBe(false);
      const badSignature = Uint8Array.from(hexToBytes(metadata.signature!));
      badSignature[0] ^= 0x01;
      expect(verifySignature(metadata.peerId, badSignature, body)).toBe(false);
    });

    it(`rejects a v${version} document whose peer identity does not match the signature`, async () => {
      const metadata = loadFixture(version);
      const misattributed = { ...metadata, peerId: 'cd'.repeat(20) };
      expect(await lookup().verifyMetadataSignature(misattributed)).toBe(false);
    });
  }
});

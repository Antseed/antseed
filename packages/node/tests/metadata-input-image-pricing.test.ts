import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { INPUT_IMAGE_PRICING_METADATA_VERSION, METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

/** An image seller: one service priced per output image, one that also charges for each image an edit sends. */
function imageMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'fal-image',
      services: ['flux-pro', 'gpt-image'],
      defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      serviceApiProtocols: { 'flux-pro': ['openai-images'], 'gpt-image': ['openai-images'] },
      serviceUnitBillingModels: {
        'flux-pro': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.05 }] } },
        'gpt-image': { 'openai-images': { version: 1, components: [
          { unit: 'output_images', priceUsd: 0.05, match: { quality: 'high' } },
          { unit: 'output_images', priceUsd: 0.012, match: { input_images: '1' } },
          { unit: 'output_images', priceUsd: 0.024, match: { input_images: '2' } },
        ] } },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('image edit prices by input images in peer metadata', () => {
  it('is v18, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBeGreaterThanOrEqual(18);
    expect(INPUT_IMAGE_PRICING_METADATA_VERSION).toBe(18);
    expect(SERVED_METADATA_VERSIONS).toContain(18);
    expect(negotiateMetadataVersion(18)).toBe(18);
    expect(negotiateMetadataVersion(17)).toBe(17);
  });

  for (const version of [INPUT_IMAGE_PRICING_METADATA_VERSION, METADATA_VERSION]) {
    it(`round-trips an input_images match in a v${version} document and re-encodes to the same signed bytes`, () => {
      const original = { ...imageMetadata(), version };
      expect(validateMetadata(original)).toEqual([]);
      const decoded = decodeMetadata(encodeMetadata(original));
      expect(decoded.version).toBe(version);
      const components = decoded.providers[0]!.serviceUnitBillingModels!['gpt-image']!['openai-images']!.components;
      expect(components[2]!.match).toEqual({ input_images: '2' });
      expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
    });
  }

  for (const version of [16, 17]) {
    it(`leaves services that price input images out of the v${version} document`, () => {
      const older = getMetadataCodec(version).fromLatest(imageMetadata());
      expect(older.providers[0]!.services).toEqual(['flux-pro']);
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
    });
  }

  it('refuses the input_images match key in a v17 document', () => {
    const messages = validateMetadata({ ...imageMetadata(), version: 17 }).map((error) => error.message);
    expect(messages).toContain('Billing match key "input_images" requires metadata version 18');
  });
});

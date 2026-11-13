import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, REFERENCE_VIDEO_PRICING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

/** A video seller: one service priced by resolution, one that also charges for reference videos. */
function videoMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'venice-video',
      services: ['wan-2.5', 'seedance-r2v'],
      defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      serviceApiProtocols: { 'wan-2.5': ['venice-video'], 'seedance-r2v': ['venice-video'] },
      serviceUnitBillingModels: {
        'wan-2.5': { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.07, match: { resolution: '720p' } }] } },
        'seedance-r2v': { 'venice-video': { version: 1, components: [
          { unit: 'video_seconds', priceUsd: 0.16, match: { resolution: '720p', aspect_ratio: '16:9' } },
          { unit: 'video_generations', priceUsd: 0 },
          { unit: 'video_generations', priceUsd: 0.79, match: { resolution: '720p', aspect_ratio: '16:9', reference_video: 'true' } },
        ] } },
      },
      serviceCapabilities: {
        'wan-2.5': { outputs: ['video'], video: { resolutions: ['720p'] } },
        'seedance-r2v': { outputs: ['video'], video: { resolutions: ['720p'], aspectRatios: ['16:9'], inputs: ['reference_image', 'reference_video', 'audio'] } },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('video prices for reference videos in peer metadata', () => {
  it('is v17, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBe(17);
    expect(REFERENCE_VIDEO_PRICING_METADATA_VERSION).toBe(17);
    expect(SERVED_METADATA_VERSIONS).toContain(17);
    expect(negotiateMetadataVersion(17)).toBe(17);
    expect(negotiateMetadataVersion(16)).toBe(16);
  });

  it('round-trips a reference_video match and re-encodes to the same signed bytes', () => {
    const original = videoMetadata();
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(17);
    const components = decoded.providers[0]!.serviceUnitBillingModels!['seedance-r2v']!['venice-video']!.components;
    expect(components[2]!.match).toEqual({ resolution: '720p', aspect_ratio: '16:9', reference_video: 'true' });
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  for (const version of [15, 16]) {
    it(`leaves services that price reference videos out of the v${version} document`, () => {
      const older = getMetadataCodec(version).fromLatest(videoMetadata());
      expect(older.providers[0]!.services).toEqual(['wan-2.5']);
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
    });
  }

  it('refuses the reference_video match key in a v16 document', () => {
    const messages = validateMetadata({ ...videoMetadata(), version: 16 }).map((error) => error.message);
    expect(messages).toContain('Billing match key "reference_video" requires metadata version 17');
  });
});

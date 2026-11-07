import { describe, expect, it } from 'vitest';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { MAX_BILLING_COMPONENTS_PER_MODEL, validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, VIDEO_OPTION_PRICING_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import type { UnitBillingComponentV1 } from '../src/types/billing.js';

const RESOLUTIONS = ['480p', '720p', '1080p'];
const ASPECT_RATIOS = ['16:9', '21:9', '1:1'];

/** Seedance-style per-second prices: one per resolution × aspect ratio × audio. */
function gridComponents(): UnitBillingComponentV1[] {
  return RESOLUTIONS.flatMap((resolution, r) => ASPECT_RATIOS.flatMap((aspect_ratio, a) => ['true', 'false'].map((audio) => ({
    unit: 'video_seconds' as const,
    priceUsd: 0.05 * (r + 1) + 0.01 * a + (audio === 'true' ? 0.005 : 0),
    match: { resolution, aspect_ratio, audio },
  }))));
}

/** A video seller: one service priced by resolution only, one by the full grid. */
function videoMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'venice-video',
      services: ['wan-2.5', 'seedance'],
      defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      serviceApiProtocols: { 'wan-2.5': ['venice-video'], seedance: ['venice-video'] },
      serviceUnitBillingModels: {
        'wan-2.5': { 'venice-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.07, match: { resolution: '720p' } }] } },
        seedance: { 'venice-video': { version: 1, components: gridComponents() } },
      },
      serviceCapabilities: {
        'wan-2.5': { outputs: ['video'], video: { resolutions: ['720p'] } },
        seedance: { outputs: ['video'], video: { resolutions: RESOLUTIONS, aspectRatios: ASPECT_RATIOS, audio: true } },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('video prices by aspect ratio and audio in peer metadata', () => {
  it('is v16, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBe(16);
    expect(VIDEO_OPTION_PRICING_METADATA_VERSION).toBe(16);
    expect(SERVED_METADATA_VERSIONS).toContain(16);
    expect(negotiateMetadataVersion(16)).toBe(16);
    expect(negotiateMetadataVersion(15)).toBe(15);
  });

  it('round-trips aspect_ratio and audio matches and re-encodes to the same signed bytes', () => {
    const original = videoMetadata();
    expect(gridComponents().length).toBeGreaterThan(MAX_BILLING_COMPONENTS_PER_MODEL);
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(16);
    const components = decoded.providers[0]!.serviceUnitBillingModels!['seedance']!['venice-video']!.components;
    expect(components).toHaveLength(18);
    expect(components[1]!.match).toEqual({ resolution: '480p', aspect_ratio: '16:9', audio: 'false' });
    expect(components[1]!.priceUsd).toBeCloseTo(0.05, 6);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  for (const version of [12, 13, 14, 15]) {
    it(`leaves services priced by aspect ratio or audio out of the v${version} document`, () => {
      const older = getMetadataCodec(version).fromLatest(videoMetadata());
      const provider = older.providers[0]!;
      expect(provider.services).toEqual(['wan-2.5']);
      expect(Object.keys(provider.serviceUnitBillingModels ?? {})).toEqual(['wan-2.5']);
      expect(Object.keys(provider.serviceCapabilities ?? {})).toEqual(['wan-2.5']);
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
      expect(decodeMetadata(encodeMetadata(older)).providers[0]!.services).toEqual(['wan-2.5']);
    });
  }

  it('leaves out a service with more than 8 components even without the new match keys', () => {
    const latest = videoMetadata();
    latest.providers[0]!.serviceUnitBillingModels!['seedance']!['venice-video']!.components = Array.from({ length: 9 }, (_, i) => ({
      unit: 'video_seconds' as const, priceUsd: 0.1 + i / 100, match: { resolution: `${i}p` },
    }));
    expect(validateMetadata(latest)).toEqual([]);
    expect(getMetadataCodec(15).fromLatest(latest).providers[0]!.services).toEqual(['wan-2.5']);
  });

  it('refuses the new match keys and the larger component count in older documents', () => {
    const messages = validateMetadata({ ...videoMetadata(), version: 15 }).map((error) => error.message);
    expect(messages).toContain('Billing match key "aspect_ratio" requires metadata version 16');
    expect(messages).toContain('Billing match key "audio" requires metadata version 16');
    expect(messages).toContain('Billing component count 18 exceeds max 8');
  });

  it('caps a v16 billing model at 64 components', () => {
    const latest = videoMetadata();
    latest.providers[0]!.serviceUnitBillingModels!['seedance']!['venice-video']!.components = Array.from({ length: 65 }, () => gridComponents()[0]!);
    expect(validateMetadata(latest).map((error) => error.message)).toContain('Billing component count 65 exceeds max 64');
  });
});

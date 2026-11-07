import { describe, expect, it } from 'vitest';
import type { UnitBillingModelV1 } from '@antseed/protocol/billing';
import type { VideoOptions } from '@antseed/protocol/peer-metadata';
import { captureUnitBillingContext, estimateUnitRequestCost, videoAttributes } from './unit-billing.js';

// Per-second prices by resolution, aspect ratio and audio (Venice charges more for 21:9, less without audio).
const seedance: UnitBillingModelV1 = {
  version: 1,
  components: [
    { unit: 'video_seconds', priceUsd: 0.07, match: { resolution: '480p', aspect_ratio: '16:9', audio: 'true' } },
    { unit: 'video_seconds', priceUsd: 0.09, match: { resolution: '480p', aspect_ratio: '21:9', audio: 'true' } },
    { unit: 'video_seconds', priceUsd: 0.05, match: { resolution: '480p', aspect_ratio: '16:9', audio: 'false' } },
  ],
};
const options: VideoOptions = { resolutions: ['480p'], aspectRatios: ['16:9', '21:9'], audio: true };

function price(body: object, videoOptions: VideoOptions | null = options, protocol: 'venice-video' | 'fal-video' = 'venice-video') {
  const captured = captureUnitBillingContext({
    sellerPeerId: 'a'.repeat(40),
    provider: 'venice-video',
    service: 'seedance',
    serviceApiProtocol: protocol,
    request: {
      requestId: 'request',
      method: 'POST',
      path: protocol === 'fal-video' ? '/fal/v1/video/queue' : '/api/v1/video/queue',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'seedance', duration: '4s', resolution: '480p', ...body })),
    },
    ...(videoOptions ? { videoOptions } : {}),
  });
  return { attributes: captured.context.attributes, cost: () => estimateUnitRequestCost(seedance, captured.context, captured.requestUsage) };
}

describe('video prices by aspect ratio and audio', () => {
  it('prices a create by its aspect ratio and audio', () => {
    expect(price({ aspect_ratio: '16:9', audio: true }).cost()).toBe(280_000n);
    expect(price({ aspect_ratio: '21:9', audio: true }).cost()).toBe(360_000n);
    expect(price({ aspect_ratio: '16:9', audio: false }).cost()).toBe(200_000n);
    expect(price({ aspect_ratio: '21:9', audio: false }).attributes).toEqual({ model: 'seedance', resolution: '480p', aspect_ratio: '21:9', audio: 'false' });
    // No component prices 21:9 without audio: refused before submission, never served free.
    expect(() => price({ aspect_ratio: '21:9', audio: false }).cost()).toThrow(/No billing component/);
  });

  it('prices omitted options as the service announces them', () => {
    expect(price({}).attributes).toEqual({ model: 'seedance', resolution: '480p', aspect_ratio: '16:9', audio: 'true' });
    expect(price({}).cost()).toBe(280_000n);
    expect(price({ audio: false }).cost()).toBe(200_000n);
    expect(price({}, { aspectRatios: ['21:9'], audio: true }).cost()).toBe(360_000n);
  });

  it('leaves an option out when neither the create nor the service names it', () => {
    expect(price({}, null).attributes).toEqual({ model: 'seedance', resolution: '480p' });
    expect(() => price({}, null).cost()).toThrow(/No billing component/);
  });

  it('reads fal\'s generate_audio', () => {
    expect(price({ aspect_ratio: '16:9', generate_audio: false }, options, 'fal-video').attributes).toMatchObject({ audio: 'false' });
    expect(price({ aspect_ratio: '16:9', audio: false }, options, 'fal-video').attributes).toMatchObject({ audio: 'false' });
  });

  it('does not assume announced options on a fal create, whose plugin does not send them', () => {
    expect(price({}, options, 'fal-video').attributes).toEqual({ model: 'seedance', resolution: '480p' });
    expect(() => price({}, options, 'fal-video').cost()).toThrow(/No billing component/);
    expect(price({ aspect_ratio: '16:9', generate_audio: true }, options, 'fal-video').cost()).toBe(280_000n);
  });

  it('builds the attributes from the facts and the announced options', () => {
    const facts = { protocol: 'venice-video' as const, action: 'create' as const, duration: 4 };
    expect(videoAttributes('seedance', facts, undefined)).toEqual({ model: 'seedance' });
    expect(videoAttributes('seedance', { ...facts, aspectRatio: '1:1', audio: false }, options)).toEqual({ model: 'seedance', aspect_ratio: '1:1', audio: 'false' });
    expect(videoAttributes('seedance', facts, { audio: false })).toEqual({ model: 'seedance', audio: 'false' });
  });
});

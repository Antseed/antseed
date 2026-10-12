import { describe, expect, it } from 'vitest';
import { getServiceMetadataId, OUTPUT_IMAGE_TOKEN_EQUIVALENT, ZERO_METADATA } from '@antseed/protocol/signatures';
import { advanceUsageMetadata, normalizeRequestUsageDelta } from './channel-usage-accounting.js';

describe('normalizeRequestUsageDelta', () => {
  const delta = {
    amount: 25_000n,
    inputTokens: 11n,
    cachedInputTokens: 3n,
    outputTokens: 7n,
    requests: 1n,
    outputImages: 1n,
    videoGenerations: 1n,
    videoSeconds: 8n,
  };

  it('removes duplicate amount and usage for an already-counted response', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: true,
      alreadyCounted: true,
    })).toEqual({
      amount: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 0n,
      outputImages: 0n,
      videoGenerations: 0n,
      videoSeconds: 0n,
    });
  });

  it('preserves the first delivered response accounting delta unchanged', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: true,
      alreadyCounted: false,
    })).toBe(delta);
  });

  it('does not count a budget/headroom authorization as a response', () => {
    expect(normalizeRequestUsageDelta(delta, {
      deliveredResponse: false,
      alreadyCounted: false,
    })).toEqual({
      amount: 0n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 0n,
      outputImages: 0n,
      videoGenerations: 0n,
      videoSeconds: 0n,
    });
  });
});

describe('NeedAuth and post-response metadata accounting', () => {
  it('attributes an image charge exactly once when both paths report it', () => {
    const service = 'qwen-image-3-pro';
    const afterNeedAuth = advanceUsageMetadata(ZERO_METADATA, service, {
      amount: 25_000n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 1n,
      outputImages: 1n,
      videoGenerations: 1n,
      videoSeconds: 8n,
    });
    const afterPostResponse = advanceUsageMetadata(
      afterNeedAuth,
      service,
      normalizeRequestUsageDelta({
        amount: 25_000n,
        inputTokens: 0n,
        cachedInputTokens: 0n,
        outputTokens: 0n,
        requests: 1n,
        outputImages: 1n,
        videoGenerations: 1n,
        videoSeconds: 8n,
      }, { deliveredResponse: true, alreadyCounted: true }),
    );

    expect(afterPostResponse).toEqual({
      cumulativeInputTokens: 0n,
      cumulativeOutputTokens: 0n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 1n,
      cumulativeVideoGenerations: 1n,
      cumulativeVideoSeconds: 8n,
      services: [{
        serviceId: getServiceMetadataId(service),
        cumulativeAmount: 25_000n,
        cumulativeInputTokens: 0n,
        cumulativeCachedInputTokens: 0n,
        cumulativeOutputTokens: 0n,
        cumulativeRequestCount: 1n,
        cumulativeOutputImages: 1n,
        cumulativeVideoGenerations: 1n,
        cumulativeVideoSeconds: 8n,
      }],
    });
  });

  it('credits the flat token equivalent per image into output tokens', () => {
    const service = 'venice-sd35';
    const images = 2n;
    const meta = advanceUsageMetadata(ZERO_METADATA, service, {
      amount: 10_000n,
      inputTokens: 8n,
      cachedInputTokens: 0n,
      outputTokens: images * OUTPUT_IMAGE_TOKEN_EQUIVALENT,
      requests: 1n,
      outputImages: images,
    });

    expect(meta.cumulativeOutputImages).toBe(2n);
    expect(meta.cumulativeOutputTokens).toBe(2n * OUTPUT_IMAGE_TOKEN_EQUIVALENT);
  });

  it('records raw video generations and seconds without adding token equivalents', () => {
    const meta = advanceUsageMetadata(ZERO_METADATA, 'venice-video', {
      amount: 4_200_000n,
      inputTokens: 0n,
      cachedInputTokens: 0n,
      outputTokens: 0n,
      requests: 1n,
      outputImages: 0n,
      videoGenerations: 1n,
      videoSeconds: 8n,
    });

    expect(meta.cumulativeVideoGenerations).toBe(1n);
    expect(meta.cumulativeVideoSeconds).toBe(8n);
    expect(meta.cumulativeOutputTokens).toBe(0n);
    expect(meta.services?.[0]).toMatchObject({
      cumulativeVideoGenerations: 1n,
      cumulativeVideoSeconds: 8n,
    });
  });
});

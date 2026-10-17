import { describe, expect, it } from 'vitest';
import {
  boundServiceMetadata,
  encodeMetadata,
  getServiceMetadataId,
  MAX_METADATA_SERVICES,
  OTHER_SERVICES_METADATA_ID,
  OUTPUT_IMAGE_TOKEN_EQUIVALENT,
  ZERO_METADATA,
} from '@antseed/protocol/signatures';
import { encodeSpendingAuth } from '@antseed/protocol/payment-codec';
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

describe('advanceUsageMetadata service cap', () => {
  const imageDelta = {
    amount: 5_000n,
    inputTokens: 0n,
    cachedInputTokens: 0n,
    outputTokens: OUTPUT_IMAGE_TOKEN_EQUIVALENT,
    requests: 1n,
    outputImages: 1n,
    videoGenerations: 0n,
    videoSeconds: 0n,
  };

  function useServices(count: number, start = ZERO_METADATA) {
    let metadata = start;
    for (let i = 0; i < count; i++) metadata = advanceUsageMetadata(metadata, `image-model-${i}`, imageDelta);
    return metadata;
  }

  it('keeps a channel that uses many services within the payment frame limit', () => {
    const metadata = useServices(200);
    expect(metadata.services).toHaveLength(MAX_METADATA_SERVICES);
    expect(metadata.cumulativeRequestCount).toBe(200n);
    expect(metadata.cumulativeOutputImages).toBe(200n);

    const other = metadata.services!.find((s) => s.serviceId === OTHER_SERVICES_METADATA_ID)!;
    expect(other.cumulativeRequestCount).toBe(BigInt(200 - (MAX_METADATA_SERVICES - 1)));
    const attributed = metadata.services!.reduce((sum, s) => sum + s.cumulativeAmount, 0n);
    expect(attributed).toBe(200n * imageDelta.amount);

    const encoded = encodeMetadata(metadata);
    const payload = {
      channelId: `0x${'1'.repeat(64)}`,
      cumulativeAmount: '1000000',
      metadataHash: `0x${'2'.repeat(64)}`,
      metadata: encoded,
      spendingAuthSig: `0x${'3'.repeat(130)}`,
      reserveBatch: {
        cumulativeAmount: '1000000',
        metadataHash: `0x${'2'.repeat(64)}`,
        metadata: encoded,
        spendingAuthSig: `0x${'3'.repeat(130)}`,
        maxAmount: '2000000',
        deadline: 1,
        reserveAuthSig: `0x${'4'.repeat(130)}`,
      },
    };
    expect(() => encodeSpendingAuth(payload)).not.toThrow();
  });

  it('keeps listed services on their own entry once the cap is reached', () => {
    const full = useServices(MAX_METADATA_SERVICES + 5);
    const listedId = getServiceMetadataId('image-model-0');
    const next = advanceUsageMetadata(full, 'image-model-0', imageDelta);
    const before = full.services!.find((s) => s.serviceId === listedId)!;
    const after = next.services!.find((s) => s.serviceId === listedId)!;
    expect(after.cumulativeRequestCount).toBe(before.cumulativeRequestCount + 1n);
    expect(next.services).toHaveLength(MAX_METADATA_SERVICES);
  });

  it('folds an oversized persisted list without losing totals', () => {
    const services = Array.from({ length: 110 }, (_, i) => ({
      serviceId: getServiceMetadataId(`legacy-${i}`),
      cumulativeAmount: BigInt(i + 1),
      cumulativeInputTokens: 1n,
      cumulativeCachedInputTokens: 0n,
      cumulativeOutputTokens: 2n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 1n,
      cumulativeVideoGenerations: 0n,
      cumulativeVideoSeconds: 0n,
    }));
    const bounded = boundServiceMetadata({ ...ZERO_METADATA, services });
    expect(bounded.services).toHaveLength(MAX_METADATA_SERVICES);
    expect(bounded.services!.reduce((sum, s) => sum + s.cumulativeAmount, 0n))
      .toBe(services.reduce((sum, s) => sum + s.cumulativeAmount, 0n));
    expect(bounded.services!.reduce((sum, s) => sum + s.cumulativeRequestCount, 0n)).toBe(110n);
    // The largest services keep their own entries.
    expect(bounded.services!.some((s) => s.serviceId === getServiceMetadataId('legacy-109'))).toBe(true);
    expect(bounded.services!.some((s) => s.serviceId === getServiceMetadataId('legacy-0'))).toBe(false);
    expect(boundServiceMetadata(bounded)).toBe(bounded);
  });
});

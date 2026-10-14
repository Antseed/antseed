import { describe, expect, it } from 'vitest';
import { advanceUsageMetadata, CountedRequestTracker, RequestServiceTracker } from '../src/payments/channel-usage-accounting.js';
import { getServiceMetadataId, ZERO_METADATA } from '../src/payments/evm/signatures.js';

describe('channel usage accounting', () => {
  it('advances aggregate and per-service metadata cumulatively', () => {
    const first = advanceUsageMetadata(ZERO_METADATA, 'gpt-free', {
      amount: 0n,
      inputTokens: 10n,
      cachedInputTokens: 2n,
      outputTokens: 5n,
      requests: 1n,
      outputImages: 0n,
    });
    const second = advanceUsageMetadata(first, 'gpt-free', {
      amount: 7n,
      inputTokens: 3n,
      cachedInputTokens: 1n,
      outputTokens: 4n,
      requests: 1n,
      outputImages: 1n,
    });

    expect(second.cumulativeInputTokens).toBe(13n);
    expect(second.cumulativeOutputTokens).toBe(9n);
    expect(second.cumulativeRequestCount).toBe(2n);
    expect(second.cumulativeOutputImages).toBe(1n);
    expect(second.services).toEqual([
      {
        serviceId: getServiceMetadataId('gpt-free'),
        cumulativeAmount: 7n,
        cumulativeInputTokens: 13n,
        cumulativeCachedInputTokens: 3n,
        cumulativeOutputTokens: 9n,
        cumulativeRequestCount: 2n,
        cumulativeOutputImages: 1n,
        cumulativeVideoGenerations: 0n,
        cumulativeVideoSeconds: 0n,
      },
    ]);
  });

  it('can advance aggregate metadata without service attribution', () => {
    const next = advanceUsageMetadata(ZERO_METADATA, undefined, {
      amount: 99n,
      inputTokens: 10n,
      cachedInputTokens: 0n,
      outputTokens: 5n,
      requests: 1n,
      outputImages: 0n,
    });

    expect(next).toEqual({
      cumulativeInputTokens: 10n,
      cumulativeOutputTokens: 5n,
      cumulativeRequestCount: 1n,
      cumulativeOutputImages: 0n,
      cumulativeVideoGenerations: 0n,
      cumulativeVideoSeconds: 0n,
      services: [],
    });
  });

  it('tracks request service attribution with bounded memory', () => {
    const tracker = new RequestServiceTracker(2);
    tracker.track('req-1', 'model-a');
    tracker.track('req-2', 'model-b');
    tracker.track('req-3', 'model-c');

    expect(tracker.get('req-1')).toBeUndefined();
    expect(tracker.take('req-2')).toBe('model-b');
    expect(tracker.take('req-2')).toBeUndefined();
    expect(tracker.get('req-3')).toBe('model-c');
  });

  it('dedupes counted requests with bounded memory', () => {
    const tracker = new CountedRequestTracker(2);
    tracker.mark('req-1');
    tracker.mark('req-2');
    tracker.mark('req-3');

    expect(tracker.has('req-1')).toBe(false);
    expect(tracker.has('req-2')).toBe(true);
    expect(tracker.has('req-3')).toBe(true);
    expect(tracker.has(undefined)).toBe(false);
  });
});

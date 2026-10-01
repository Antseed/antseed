import { describe, expect, it } from 'vitest';
import { CacheObservations } from './cache-observations.js';

const candidate = { peerId: 'a'.repeat(40), provider: 'openai', serviceId: 'model', inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
const observation = { ...candidate, conversationKey: 'chat', requestId: 'first', inputTokens: 100, cachedInputTokens: 80 };

describe('prompt cache estimates', () => {
  it('matches the smoothed ratio, previous prompt cap, current prompt cap and three-minute expiry', () => {
    let now = 0;
    const cache = new CacheObservations(() => now);
    expect(cache.expectedCachedInputTokens('chat', candidate, 200)).toBe(0);
    cache.record(observation);
    expect(cache.expectedCachedInputTokens('chat', candidate, 200)).toBe(80);
    cache.record({ ...observation, requestId: 'second', inputTokens: 200, cachedInputTokens: 40 });
    expect(cache.expectedCachedInputTokens('chat', candidate, 300)).toBe(100);
    expect(cache.expectedCachedInputTokens('chat', candidate, 60)).toBe(60);
    now = 180_001;
    expect(cache.expectedCachedInputTokens('chat', candidate, 300)).toBe(0);
  });

  it('deduplicates observations and isolates conversations, peers, providers and models', () => {
    const cache = new CacheObservations();
    cache.record(observation);
    cache.record({ ...observation, cachedInputTokens: 0 });
    expect(cache.expectedCachedInputTokens('chat', candidate, 100)).toBe(80);
    for (const other of [{ ...candidate, peerId: 'b'.repeat(40) }, { ...candidate, provider: 'other' }, { ...candidate, serviceId: 'other' }]) {
      expect(cache.expectedCachedInputTokens('chat', other, 100)).toBe(0);
    }
    expect(cache.expectedCachedInputTokens('child-chat', candidate, 100)).toBe(0);
    expect(cache.expectedCachedInputTokens(null, candidate, 100)).toBe(0);
  });

  it('ignores invalid observations and bounds conversation history', () => {
    const cache = new CacheObservations();
    for (const counts of [{ inputTokens: 0 }, { cachedInputTokens: 101 }, { inputTokens: 1.5 }]) cache.record({ ...observation, ...counts });
    expect(cache.expectedCachedInputTokens('chat', candidate, 100)).toBe(0);
    cache.record(observation);
    for (let index = 0; index < 500; index++) cache.record({ ...observation, conversationKey: `chat-${index}` });
    expect(cache.expectedCachedInputTokens('chat', candidate, 100)).toBe(0);
  });
});

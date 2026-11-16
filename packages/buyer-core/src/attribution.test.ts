import { describe, expect, it } from 'vitest';
import { clientIdFromAgentId, decodeMetadataAttribution, encodeMetadata, ZERO_METADATA } from '@antseed/protocol/signatures';
import { advanceUsageMetadata } from './channel-usage-accounting.js';

describe('usage attribution through metadata advancement', () => {
  const invite = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
  const attribution = { clientId: clientIdFromAgentId(42), invite };
  const delta = { amount: 10n, inputTokens: 5n, cachedInputTokens: 0n, outputTokens: 3n, requests: 1n, outputImages: 0n };

  it('carries attribution from the previous metadata into the advanced one', () => {
    const first = advanceUsageMetadata({ ...ZERO_METADATA, attribution }, 'openai:gpt-4o', delta);
    const second = advanceUsageMetadata(first, 'openai:gpt-4o', delta);
    expect(second.attribution).toEqual(attribution);
    expect(decodeMetadataAttribution(encodeMetadata(second))).toEqual({ clientId: attribution.clientId, invite });
    expect(second.services?.length).toBe(1);
    expect(second.cumulativeRequestCount).toBe(2n);
  });

  it('leaves metadata untouched when no attribution is set', () => {
    const advanced = advanceUsageMetadata(ZERO_METADATA, undefined, delta);
    expect('attribution' in advanced).toBe(false);
    expect(decodeMetadataAttribution(encodeMetadata(advanced))).toBeNull();
  });
});

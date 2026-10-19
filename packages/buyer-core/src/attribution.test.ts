import { describe, expect, it } from 'vitest';
import { clientIdFromAgentId, decodeMetadataAttribution, encodeMetadata, ZERO_METADATA } from '@antseed/protocol/signatures';
import { Wallet } from 'ethers';
import { advanceUsageMetadata } from './channel-usage-accounting.js';
import { BuyerFreeUsageManager } from './buyer-free-usage-manager.js';

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

describe('free usage attribution', () => {
  const invite = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
  const attribution = { clientId: clientIdFromAgentId(42), invite };
  const delta = { amount: 0n, inputTokens: 5n, cachedInputTokens: 0n, outputTokens: 3n, requests: 1n, outputImages: 0n };
  type Internals = { _advanceUsageMetadata(previous: unknown, service: string | undefined, d: typeof delta): { attribution?: unknown } };

  function manager(withAttribution: boolean): BuyerFreeUsageManager {
    return new BuyerFreeUsageManager({ wallet: Wallet.createRandom() } as never, {
      chainId: 31337,
      freeUsageContractAddress: '0x0165878A594ca255338adfa4d48449f69242Eb8F',
      defaultAuthDurationSecs: 3600,
      ...(withAttribution ? { attribution } : {}),
    });
  }

  it('drops a cleared attribution from the next signed metadata', () => {
    const free = manager(true);
    const internals = free as unknown as Internals;
    const first = internals._advanceUsageMetadata({ ...ZERO_METADATA }, 'openai:gpt-4o', delta);
    expect(first.attribution).toEqual(attribution);
    free.setAttribution(undefined);
    expect(internals._advanceUsageMetadata(first, 'openai:gpt-4o', delta).attribution).toBeUndefined();
  });

  it('signs no attribution for hydrated attributed metadata when none is set', () => {
    const internals = manager(false) as unknown as Internals;
    expect(internals._advanceUsageMetadata({ ...ZERO_METADATA, attribution }, 'openai:gpt-4o', delta).attribution).toBeUndefined();
  });
});

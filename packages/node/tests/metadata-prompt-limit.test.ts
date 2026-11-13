import { describe, expect, it } from 'vitest';
import * as node from '../src/index.js';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { MAX_CAPABILITY_TOKEN_COUNT, METADATA_VERSION, PROMPT_LIMIT_METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';

/** A free-tier seller: one service whose prompts are capped well below its context window, one without a cap. */
function promptLimitMetadata(): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'openai',
      services: ['free-chat', 'paid-chat'],
      defaultPricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      serviceApiProtocols: { 'free-chat': ['openai-chat-completions'], 'paid-chat': ['openai-chat-completions'] },
      serviceCapabilities: {
        'free-chat': { contextWindow: 131_072, maxPromptTokens: 4_000, maxOutputTokens: 1_024 },
        'paid-chat': { contextWindow: 131_072, maxOutputTokens: 8_192 },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

describe('per-service prompt limit in peer metadata', () => {
  it('is v18, served to buyers that ask for it', () => {
    expect(PROMPT_LIMIT_METADATA_VERSION).toBe(18);
    expect(METADATA_VERSION).toBeGreaterThanOrEqual(PROMPT_LIMIT_METADATA_VERSION);
    expect(SERVED_METADATA_VERSIONS).toContain(18);
    expect(negotiateMetadataVersion(18)).toBe(18);
    expect(negotiateMetadataVersion(17)).toBe(17);
  });

  it('is exported from the package root', () => {
    expect(node.PROMPT_LIMIT_METADATA_VERSION).toBe(PROMPT_LIMIT_METADATA_VERSION);
  });

  it('round-trips maxPromptTokens and re-encodes to the same signed bytes', () => {
    const original = promptLimitMetadata();
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(METADATA_VERSION);
    expect(decoded.providers[0]!.serviceCapabilities).toEqual(original.providers[0]!.serviceCapabilities);
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  for (const version of [12, 15, 17]) {
    it(`drops maxPromptTokens from the v${version} document and keeps the service`, () => {
      const older = getMetadataCodec(version).fromLatest(promptLimitMetadata());
      expect(older.providers[0]!.services).toEqual(['free-chat', 'paid-chat']);
      expect(older.providers[0]!.serviceCapabilities!['free-chat']).toEqual({ contextWindow: 131_072, maxOutputTokens: 1_024 });
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
      expect(decodeMetadata(encodeMetadata(older)).providers[0]!.serviceCapabilities).toEqual(older.providers[0]!.serviceCapabilities);
    });
  }

  it('refuses maxPromptTokens in a v17 document', () => {
    const messages = validateMetadata({ ...promptLimitMetadata(), version: 17 }).map((error) => error.message);
    expect(messages).toContain('Service capability "maxPromptTokens" requires metadata version 18');
    expect(() => encodeMetadata({ ...promptLimitMetadata(), version: 17 })).toThrow('maxPromptTokens requires metadata version 18');
  });

  it('accepts only positive integers up to the token-count ceiling', () => {
    for (const bad of [0, -1, 1.5, MAX_CAPABILITY_TOKEN_COUNT + 1]) {
      const metadata = promptLimitMetadata();
      metadata.providers[0]!.serviceCapabilities!['free-chat']!.maxPromptTokens = bad;
      expect(validateMetadata(metadata).length).toBeGreaterThan(0);
    }
    const max = promptLimitMetadata();
    max.providers[0]!.serviceCapabilities!['free-chat']!.maxPromptTokens = MAX_CAPABILITY_TOKEN_COUNT;
    expect(validateMetadata(max)).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { Wallet } from 'ethers';
import { signData, verifySignature } from '@antseed/protocol';
import { decodeMetadata, encodeMetadata, encodeMetadataForSigning, getMetadataCodec, negotiateMetadataVersion, SERVED_METADATA_VERSIONS } from '../src/discovery/metadata-codec.js';
import { validateMetadata } from '../src/discovery/metadata-validator.js';
import { METADATA_VERSION, REASONING_EFFORTS_METADATA_VERSION, type PeerMetadata, type ServiceCapabilities } from '../src/discovery/peer-metadata.js';

/** A seller of two chat models; `model-a` announces `capabilities`. */
function reasoningMetadata(capabilities: ServiceCapabilities = { reasoning: true, reasoningEfforts: ['medium', 'high', 'low'] }): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    region: 'us-east-1',
    timestamp: 1_700_000_000_000,
    signature: 'b'.repeat(130),
    providers: [{
      provider: 'openai',
      services: ['model-a', 'model-b'],
      defaultPricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.45 },
      serviceApiProtocols: { 'model-a': ['openai-chat-completions'], 'model-b': ['openai-chat-completions'] },
      serviceCapabilities: {
        'model-a': { contextWindow: 128_000, toolUse: true, ...capabilities },
        'model-b': { contextWindow: 64_000 },
      },
      maxConcurrency: 10,
      currentLoad: 0,
    }],
  };
}

const capabilitiesOf = (metadata: PeerMetadata, service = 'model-a') =>
  metadata.providers[0]!.serviceCapabilities?.[service];

describe('reasoning efforts in peer metadata', () => {
  it('is v19, served to buyers that ask for it', () => {
    expect(METADATA_VERSION).toBeGreaterThanOrEqual(19);
    expect(REASONING_EFFORTS_METADATA_VERSION).toBe(19);
    expect(SERVED_METADATA_VERSIONS).toContain(19);
    expect(negotiateMetadataVersion(19)).toBe(19);
    expect(negotiateMetadataVersion(18)).toBe(18);
  });

  it('round-trips a reasoning effort list and re-encodes to the same signed bytes', () => {
    const original = reasoningMetadata();
    expect(validateMetadata(original)).toEqual([]);
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(decoded.version).toBe(METADATA_VERSION);
    // Announced in code-unit order, so re-encoding decoded metadata is byte-stable.
    expect(capabilitiesOf(decoded)?.reasoningEfforts).toEqual(['high', 'low', 'medium']);
    expect(capabilitiesOf(decoded, 'model-b')).toEqual({ contextWindow: 64_000 });
    expect(encodeMetadataForSigning(decoded)).toEqual(encodeMetadataForSigning(original));
  });

  it('keeps an empty list distinct from no list', () => {
    const empty = decodeMetadata(encodeMetadata(reasoningMetadata({ reasoning: true, reasoningEfforts: [] })));
    expect(capabilitiesOf(empty)?.reasoningEfforts).toEqual([]);
    const absent = decodeMetadata(encodeMetadata(reasoningMetadata({ reasoning: true })));
    expect(capabilitiesOf(absent)).not.toHaveProperty('reasoningEfforts');
    expect(encodeMetadataForSigning(empty)).not.toEqual(encodeMetadataForSigning(absent));
  });

  it('signs the list', () => {
    const original = reasoningMetadata();
    const wallet = new Wallet(Wallet.createRandom().privateKey);
    const signature = signData(wallet, encodeMetadataForSigning(original));
    const decoded = decodeMetadata(encodeMetadata(original));
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(decoded))).toBe(true);
    decoded.providers[0]!.serviceCapabilities!['model-a']!.reasoningEfforts = ['high', 'low', 'max'];
    expect(verifySignature(wallet.address.slice(2), signature, encodeMetadataForSigning(decoded))).toBe(false);
  });

  for (const version of [12, 15, 18]) {
    it(`leaves the list out of the v${version} document and keeps the service`, () => {
      const older = getMetadataCodec(version).fromLatest(reasoningMetadata());
      expect(older.version).toBe(version);
      const provider = older.providers[0]!;
      expect(provider.services).toEqual(['model-a', 'model-b']);
      expect(capabilitiesOf(older)).toEqual({ contextWindow: 128_000, toolUse: true, reasoning: true });
      expect(validateMetadata({ ...older, signature: 'b'.repeat(130) })).toEqual([]);
      const decoded = decodeMetadata(encodeMetadata(older));
      expect(decoded.providers[0]!.services).toEqual(['model-a', 'model-b']);
      expect(capabilitiesOf(decoded)).not.toHaveProperty('reasoningEfforts');
    });
  }

  it('keeps a service whose only capability is an effort list in older documents', () => {
    const latest = reasoningMetadata();
    latest.providers[0]!.serviceCapabilities = { 'model-a': { reasoningEfforts: ['low'] } };
    const older = getMetadataCodec(18).fromLatest(latest);
    expect(older.providers[0]!.services).toEqual(['model-a', 'model-b']);
    expect(older.providers[0]!.serviceCapabilities).toBeUndefined();
    expect(() => encodeMetadataForSigning(older)).not.toThrow();
  });

  it('refuses a list in documents older than v19', () => {
    const older = { ...reasoningMetadata(), version: 18 };
    const messages = validateMetadata(older).map((error) => error.message);
    expect(messages).toContain('Service capability "reasoningEfforts" requires metadata version 19');
    expect(() => encodeMetadataForSigning(older)).toThrow('Reasoning efforts require metadata version 19');
  });

  it('refuses a non-empty list on a service that announces reasoning false', () => {
    const contradictory = reasoningMetadata({ reasoning: false, reasoningEfforts: ['low'] });
    expect(validateMetadata(contradictory).map((error) => error.message).join('\n')).toContain('reasoningEfforts must be empty when reasoning is false');
    expect(validateMetadata(reasoningMetadata({ reasoning: false, reasoningEfforts: [] }))).toEqual([]);
    const malformed = reasoningMetadata({ reasoningEfforts: ['high', 'high'] });
    expect(validateMetadata(malformed).map((error) => error.message).join('\n')).toContain('reasoningEfforts must contain');
  });
});

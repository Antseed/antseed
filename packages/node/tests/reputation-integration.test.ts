import { describe, it, expect } from 'vitest';
import { encodeMetadata, decodeMetadata } from '../src/discovery/metadata-codec.js';
import { METADATA_VERSION, type PeerMetadata } from '../src/discovery/peer-metadata.js';
import { computeTrustScore } from '../src/reputation/trust-score.js';
import type { PeerInfo } from '../src/types/peer.js';

function makeMetadata(overrides?: Partial<PeerMetadata>): PeerMetadata {
  return {
    peerId: 'a'.repeat(40) as any,
    version: METADATA_VERSION,
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-3-opus'],
        defaultPricing: {
          inputUsdPerMillion: 15,
          outputUsdPerMillion: 75,
        },
        maxConcurrency: 10,
        currentLoad: 3,
      },
    ],
    region: 'us-east-1',
    timestamp: 1700000000000,
    signature: 'b'.repeat(130),
    ...overrides,
  };
}

describe('Reputation Integration', () => {
  it('should round-trip metadata with reputation', () => {
    const original = makeMetadata({
      onChainChannelCount: 42,
      onChainGhostCount: 2,
    });
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.onChainChannelCount).toBe(42);
    expect(decoded.onChainGhostCount).toBe(2);
    // Verify other fields are still correct
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
    expect(decoded.providers).toHaveLength(1);
    expect(decoded.providers[0]!.provider).toBe('anthropic');
  });

  it('should decode metadata without reputation fields (backward compat)', () => {
    // Encode without reputation fields
    const original = makeMetadata();
    const encoded = encodeMetadata(original);
    const decoded = decodeMetadata(encoded);

    expect(decoded.onChainChannelCount).toBeUndefined();
    expect(decoded.onChainGhostCount).toBeUndefined();
    // Core fields should still work
    expect(decoded.peerId).toBe(original.peerId);
    expect(decoded.region).toBe(original.region);
    expect(decoded.timestamp).toBe(original.timestamp);
  });

  it('should populate PeerInfo from metadata reputation', () => {
    const metadata: PeerMetadata = makeMetadata({
      onChainChannelCount: 100,
      onChainGhostCount: 1,
    });

    // Simulate what _lookupResultToPeerInfo does
    const peerInfo: PeerInfo = {
      peerId: metadata.peerId,
      lastSeen: metadata.timestamp,
      providers: metadata.providers.map((p) => p.provider),
      publicAddress: '1.2.3.4:6882',
      onChainChannelCount: metadata.onChainChannelCount,
      onChainGhostCount: metadata.onChainGhostCount,
    };

    expect(peerInfo.onChainChannelCount).toBe(100);
    expect(peerInfo.onChainGhostCount).toBe(1);
  });

  it('should prefer the buyer trust score over reported reputation', () => {
    function effectiveReputation(p: PeerInfo): number {
      return computeTrustScore(p)?.score ?? p.reputationScore ?? 0;
    }

    // Keep this coupled to path selection, not the exact score curve.
    const reportedScore = 30;
    const peer: PeerInfo = {
      peerId: 'a'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['anthropic'],
      onChainUsageEpoch: 22,
      onChainUsageShareBps: 2_000,
      onChainPoolPowerShareBps: 2_000,
      onChainWashFlagged: false,
      reputationScore: reportedScore,
    };

    const computed = computeTrustScore(peer)?.score;
    expect(computed).not.toBeUndefined();
    expect(effectiveReputation(peer)).toBe(computed);
    expect(effectiveReputation(peer)).not.toBe(reportedScore);
  });

  it('should fall back to reported reputation when on-chain reputation is not available', () => {
    function effectiveReputation(p: PeerInfo): number {
      return computeTrustScore(p)?.score ?? p.reputationScore ?? 0;
    }

    const peerWithRep: PeerInfo = {
      peerId: 'b'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
      reputationScore: 55,
    };

    const peerWithNothing: PeerInfo = {
      peerId: 'c'.repeat(40) as any,
      lastSeen: Date.now(),
      providers: ['openai'],
    };

    expect(effectiveReputation(peerWithRep)).toBe(55);
    expect(effectiveReputation(peerWithNothing)).toBe(0);
  });

});

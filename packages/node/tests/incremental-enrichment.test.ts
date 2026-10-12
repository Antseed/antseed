import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, type PeerInfo } from '../src/node.js';
import { GITHUB_VERIFICATION_PROOF_TYPE } from '../src/discovery/github-verification.js';
import * as publicJson from '../src/reputation/public-json.js';

function makePeer(peerId = 'a'.repeat(40)): PeerInfo {
  return {
    peerId: peerId as PeerInfo['peerId'],
    providers: ['openai'],
    lastSeen: Date.now(),
  };
}

function signals(overrides: Record<string, unknown> = {}) {
  return {
    agentId: 123, channelCount: 25, ghostCount: 0, totalVolumeUsdcMicros: 50_000_000, lastSettledAtSec: Math.floor(Date.now() / 1000),
    usageEpoch: 22, usageShareBps: 1_500, usageLastEpochUsdcMicros: 120_000_000,
    poolStakeAnts: 10, poolPowerShareBps: 1_500, washFlagged: false, washShareBps: 0,
    ...overrides,
  };
}

describe('AntseedNode incremental discovery enrichment', () => {
  it('emits an enriched peer update after a partial metadata-only discovery event', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    const discovered = vi.fn();

    node.on('peers:discovered', discovered);
    (node as any)._started = true;
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = { read };

    (node as any)._queuePartialPeerEnrichment([peer]);
    await (node as any)._partialPeerEnrichmentChain;

    expect(read).toHaveBeenCalledTimes(1);
    expect(discovered).toHaveBeenCalledTimes(1);
    const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
    expect(peers).toHaveLength(1);
    expect(peers[0]?.peerId).toBe(peer.peerId);
    expect(peers[0]?.onChainAgentId).toBe(123);
    expect(peers[0]?.onChainChannelCount).toBe(25);
    expect(peers[0]?.onChainTotalVolumeUsdcMicros).toBe(50_000_000);
    expect(peers[0]?.onChainUsageShareBps).toBe(1_500);
    expect(peers[0]?.onChainPoolPowerShareBps).toBe(1_500);
    expect(peers[0]?.onChainWashFlagged).toBe(false);
    expect(peers[0]?.onChainStatsFetchedAt).toEqual(expect.any(Number));
    expect(peers[0]?.trust?.usage?.shareBps).toBe(1_500);
    expect(peers[0]?.onChainReputationScore).toBeGreaterThan(30);
  });

  it('reads every stale peer in one batch and skips fresh ones', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const stale = [makePeer('a'.repeat(40)), makePeer('b'.repeat(40))];
    const fresh = makePeer('c'.repeat(40));
    fresh.onChainStatsFetchedAt = Date.now();
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = { read };

    await (node as any)._enrichPeersWithOnChainStats([...stale, fresh]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toHaveLength(2);
    expect(stale.every((p) => typeof p.onChainReputationScore === 'number')).toBe(true);
    expect(fresh.onChainAgentId).toBeUndefined();
  });

  it('keeps the last-known snapshot when the batched read fails or omits the peer', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const previousFetchedAt = Date.now() - 300_000;
    const peer = makePeer();
    peer.onChainChannelCount = 1_208;
    peer.onChainReputationScore = 80;
    peer.onChainStatsFetchedAt = previousFetchedAt;
    (node as any)._trustSignalsClient = { read: vi.fn().mockRejectedValue(new Error('transient RPC failure')) };
    await (node as any)._enrichPeersWithOnChainStats([peer]);
    expect(peer.onChainChannelCount).toBe(1_208);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);

    (node as any)._trustSignalsClient = { read: vi.fn().mockResolvedValue(new Map()) };
    await (node as any)._enrichPeersWithOnChainStats([peer]);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);
  });

  it('zeroes the score of a proven wash trader', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    (node as any)._trustSignalsClient = { read: vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals({ washFlagged: true, washShareBps: 6_000 })]))) };
    await (node as any)._enrichPeersWithOnChainStats([peer]);
    expect(peer.onChainWashFlagged).toBe(true);
    expect(peer.onChainReputationScore).toBe(0);
    expect(peer.trust?.washFlagged).toBe(true);
  });

  it('emits external verification results without blocking initial discovery events', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    peer.metadata = {
      peerId: peer.peerId,
      version: 10,
      providers: [],
      region: 'unknown',
      timestamp: Date.now(),
      signature: '00'.repeat(65),
      verifications: {
        github: [{ username: 'octocat' }],
      },
    };
    const discovered = vi.fn();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      type: GITHUB_VERIFICATION_PROOF_TYPE,
      peerId: peer.peerId,
      username: 'octocat',
    }), { status: 200 }));

    node.on('peers:discovered', discovered);
    const proofFetch = vi.spyOn(publicJson, 'fetchPublicProof').mockImplementation(fetchMock);
    (node as any)._identityHistoryCollector = { collect: vi.fn().mockResolvedValue({ version: 1, identities: [] }) };
    try {
      (node as any)._started = true;
      (node as any)._queueExternalVerification([peer]);
      expect(discovered).not.toHaveBeenCalled();

      await (node as any)._externalVerificationChain;

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(discovered).toHaveBeenCalledTimes(1);
      const [[peers]] = discovered.mock.calls as [[PeerInfo[]]];
      expect(peers[0]?.verificationResults?.verified).toBe(true);
      expect(peers[0]?.verificationResults?.github[0]?.username).toBe('octocat');
      expect(peers[0]?.verificationResults?.identityHistory?.version).toBe(1);
    } finally {
      proofFetch.mockRestore();
    }
  });

  it('emits a combined trust score when chain enrichment finishes before identity verification', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    peer.metadata = {
      peerId: peer.peerId,
      version: 10,
      providers: [],
      region: 'unknown',
      timestamp: Date.now(),
      signature: '00'.repeat(65),
      verifications: { github: [{ username: 'octocat', repository: 'proof' }] },
    };
    const discovered = vi.fn();
    let releaseProof!: () => void;
    const proofReady = new Promise<void>((resolve) => { releaseProof = resolve; });
    const fetchMock = vi.fn(async () => {
      await proofReady;
      return new Response(JSON.stringify({
        type: GITHUB_VERIFICATION_PROOF_TYPE,
        peerId: peer.peerId,
        username: 'octocat',
      }), { status: 200 });
    });
    const now = Date.now();

    node.on('peers:discovered', discovered);
    const proofFetch = vi.spyOn(publicJson, 'fetchPublicProof').mockImplementation(fetchMock);
    (node as any)._identityHistoryCollector = { collect: vi.fn().mockResolvedValue({
      version: 1,
      identities: [{
        kind: 'github', claim: 'octocat', identityId: 'github:42', status: 'available', fetchedAtMs: now,
        createdAtMs: now - 10 * 365.25 * 86_400_000,
        projects: Array.from({ length: 8 }, (_, index) => ({
          id: index + 1, name: `project-${index}`, createdAtMs: now - 4 * 365.25 * 86_400_000,
          stars: 100, archived: false,
        })),
      }],
    }) };
    (node as any)._trustSignalsClient = {
      read: vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])))
    };
    try {
      (node as any)._started = true;
      (node as any)._queueExternalVerification([peer]);
      (node as any)._queuePartialPeerEnrichment([peer]);

      await (node as any)._partialPeerEnrichmentChain;
      expect(discovered.mock.calls.at(-1)?.[0]?.[0]?.trust?.usage).not.toBeNull();
      expect(discovered.mock.calls.at(-1)?.[0]?.[0]?.trust?.identity).toBeNull();

      releaseProof();
      await (node as any)._externalVerificationChain;

      const combined = discovered.mock.calls.at(-1)?.[0]?.[0] as PeerInfo | undefined;
      expect(combined?.trust?.usage).not.toBeNull();
      expect(combined?.trust?.power).not.toBeNull();
      expect(combined?.trust?.identity?.kind).toBe('github');
      expect(combined?.onChainReputationScore).toBeGreaterThan(60);
    } finally {
      proofFetch.mockRestore();
    }
  });

  it('reuses verified identity results for the full identity-history TTL', () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    peer.metadata = {
      peerId: peer.peerId,
      version: 10,
      providers: [],
      region: 'unknown',
      timestamp: Date.now(),
      signature: '00'.repeat(65),
      verifications: { github: [{ username: 'octocat' }] },
    };
    const results = {
      verified: true,
      checkedAtMs: Date.now() - 60 * 60_000,
      domains: [],
      github: [{ username: 'octocat', repository: 'octocat', peerId: peer.peerId, verified: true, checkedAtMs: Date.now() - 60 * 60_000 }],
    };
    (node as any)._externalVerificationCache.set(peer.peerId, {
      claimsKey: (node as any)._externalVerificationClaimsKey(peer),
      checkedAtMs: results.checkedAtMs,
      results,
    });

    (node as any)._attachCachedExternalVerificationResults([peer]);

    expect(peer.verificationResults).toBe(results);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { AntseedNode, ON_CHAIN_STATS_MISS_TTL_MS, ON_CHAIN_STATS_TTL_MS, VERIFICATION_STATUS_STALE_MAX_MS, VERIFICATION_STATUS_TTL_MS, type PeerInfo } from '../src/node.js';
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

/**
 * A trust client whose `read` mock returns the signals by seller; sellers it
 * leaves out count as confirmed unregistered (no agent id), unless `failed`
 * lists them as failed reads.
 */
function trustClient(read: (sellers: string[]) => Promise<Map<string, unknown>>, failed: readonly string[] = []) {
  return {
    readWithMisses: async (sellers: string[]) => {
      const result = await read(sellers);
      return { signals: result, unregistered: new Set(sellers.filter((seller) => !result.has(seller) && !failed.includes(seller))) };
    },
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
    (node as any)._trustSignalsClient = trustClient(read);

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
    (node as any)._trustSignalsClient = trustClient(read);

    await (node as any)._enrichPeersWithOnChainStats([...stale, fresh]);

    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toHaveLength(2);
    expect(stale.every((p) => typeof p.onChainReputationScore === 'number')).toBe(true);
    expect(fresh.onChainAgentId).toBeUndefined();
  });

  it('reuses a fresh read for newly built PeerInfo objects of the same peer', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = trustClient(read);

    await (node as any)._enrichPeersWithOnChainStats([makePeer('a'.repeat(40))]);
    // A later discovery cycle rebuilds the PeerInfo without on-chain fields.
    const rediscovered = makePeer('a'.repeat(40));
    const unregistered = makePeer('b'.repeat(40));
    read.mockImplementationOnce(async () => new Map());
    await (node as any)._enrichPeersWithOnChainStats([rediscovered, unregistered]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0]).toHaveLength(1);
    expect(rediscovered.onChainChannelCount).toBe(25);
    expect(typeof rediscovered.onChainReputationScore).toBe('number');

    // Both peers (including the one without an agent id) are now cached.
    await (node as any)._enrichPeersWithOnChainStats([makePeer('a'.repeat(40)), makePeer('b'.repeat(40))]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('re-reads a peer once the on-chain stats TTL (2 min) has passed', async () => {
    vi.useFakeTimers();
    try {
      const node = new AntseedNode({ role: 'buyer' });
      const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
      (node as any)._trustSignalsClient = trustClient(read);
      expect(ON_CHAIN_STATS_TTL_MS).toBe(120_000);
      await (node as any)._enrichPeersWithOnChainStats([makePeer()]);
      vi.advanceTimersByTime(ON_CHAIN_STATS_TTL_MS - 1_000);
      await (node as any)._enrichPeersWithOnChainStats([makePeer()]);
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      await (node as any)._enrichPeersWithOnChainStats([makePeer()]);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-checks a peer without an agent id after the shorter miss TTL', async () => {
    vi.useFakeTimers();
    try {
      const node = new AntseedNode({ role: 'buyer' });
      const read = vi.fn(async () => new Map());
      (node as any)._trustSignalsClient = trustClient(read);
      await (node as any)._enrichPeersWithOnChainStats([makePeer()]);
      vi.advanceTimersByTime(ON_CHAIN_STATS_MISS_TTL_MS - 1_000);
      await (node as any)._enrichPeersWithOnChainStats([makePeer()]);
      expect(read).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(2_000);
      read.mockImplementationOnce(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
      const registered = makePeer();
      await (node as any)._enrichPeersWithOnChainStats([registered]);
      expect(read).toHaveBeenCalledTimes(2);
      expect(registered.onChainAgentId).toBe(123);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reads a peer again at once when its seller contract changes', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = trustClient(read);
    (node as any)._sellerAddressResolver = { resolveSellerAddress: async (peerId: string, metadata?: { sellerContract?: string }) => metadata?.sellerContract ?? `0x${peerId}` };
    const withContract = (contract: string): PeerInfo => ({ ...makePeer(), metadata: { sellerContract: contract } as unknown as PeerInfo['metadata'] });
    await (node as any)._enrichPeersWithOnChainStats([withContract('0x' + '1'.repeat(40))]);
    await (node as any)._enrichPeersWithOnChainStats([withContract('0x' + '1'.repeat(40))]);
    expect(read).toHaveBeenCalledTimes(1);
    await (node as any)._enrichPeersWithOnChainStats([withContract('0x' + '2'.repeat(40))]);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('resolves seller addresses a few at a time instead of all at once', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = trustClient(read);
    let inFlight = 0;
    let maxInFlight = 0;
    (node as any)._sellerAddressResolver = {
      resolveSellerAddress: async (peerId: string) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 1));
        inFlight--;
        return `0x${peerId}`;
      },
    };
    const peers = Array.from({ length: 40 }, (_, index) => makePeer(index.toString(16).padStart(40, '0')));
    await (node as any)._enrichPeersWithOnChainStats(peers);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toHaveLength(40);
    expect(peers.every((peer) => peer.onChainAgentId === 123)).toBe(true);
  });

  it('merges partial discovery batches queued during a read into one batched read', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    (node as any)._started = true;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const read = vi.fn(async (sellers: string[]) => {
      if (read.mock.calls.length === 1) await gate;
      return new Map(sellers.map((seller) => [seller, signals()]));
    });
    (node as any)._trustSignalsClient = trustClient(read);
    const discovered = vi.fn();
    node.on('peers:discovered', discovered);

    (node as any)._queuePartialPeerEnrichment([makePeer('a'.repeat(40))]);
    await new Promise((resolve) => setImmediate(resolve));
    // Three more partial batches arrive while the first read is in flight.
    (node as any)._queuePartialPeerEnrichment([makePeer('b'.repeat(40))]);
    (node as any)._queuePartialPeerEnrichment([makePeer('c'.repeat(40))]);
    (node as any)._queuePartialPeerEnrichment([makePeer('d'.repeat(40)), makePeer('b'.repeat(40))]);
    release();
    await (node as any)._partialPeerEnrichmentChain;
    await (node as any)._partialPeerEnrichmentChain;

    expect(read).toHaveBeenCalledTimes(2);
    expect(read.mock.calls[1]![0]).toHaveLength(3);
    expect(discovered).toHaveBeenCalledTimes(2);
    expect((discovered.mock.calls[1]![0] as PeerInfo[]).map((p) => p.peerId[0]).sort()).toEqual(['b', 'c', 'd']);
  });

  it('keeps the last-known snapshot when the batched read fails or omits the peer', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const previousFetchedAt = Date.now() - 300_000;
    const peer = makePeer();
    peer.onChainChannelCount = 1_208;
    peer.onChainReputationScore = 80;
    peer.onChainStatsFetchedAt = previousFetchedAt;
    (node as any)._trustSignalsClient = trustClient(vi.fn().mockRejectedValue(new Error('transient RPC failure')));
    await (node as any)._enrichPeersWithOnChainStats([peer]);
    expect(peer.onChainChannelCount).toBe(1_208);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);

    (node as any)._trustSignalsClient = trustClient(vi.fn().mockResolvedValue(new Map()));
    await (node as any)._enrichPeersWithOnChainStats([peer]);
    expect(peer.onChainReputationScore).toBe(80);
    expect(peer.onChainStatsFetchedAt).toBe(previousFetchedAt);
  });

  it('does not cache a failed agent-id read as "no agent id"', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const address = 'a'.repeat(40);
    const read = vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()])));
    (node as any)._trustSignalsClient = trustClient(read);
    await (node as any)._enrichPeersWithOnChainStats([makePeer(address)]);
    // Expire the cached read so the next pass reads again, and fail it.
    (node as any)._onChainStatsCache.get(address).fetchedAt -= ON_CHAIN_STATS_TTL_MS;
    const failing = vi.fn(async () => new Map());
    (node as any)._trustSignalsClient = trustClient(failing, [`0x${address}`, address]);
    const rediscovered = makePeer(address);
    await (node as any)._enrichPeersWithOnChainStats([rediscovered]);
    // The previous snapshot is still shown, and the next pass retries at once.
    expect(rediscovered.onChainAgentId).toBe(123);
    await (node as any)._enrichPeersWithOnChainStats([makePeer(address)]);
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it('zeroes the score of a proven wash trader', async () => {
    const node = new AntseedNode({ role: 'buyer' });
    const peer = makePeer();
    (node as any)._trustSignalsClient = trustClient(vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals({ washFlagged: true, washShareBps: 6_000 })]))));
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
    (node as any)._trustSignalsClient = trustClient(vi.fn(async (sellers: string[]) => new Map(sellers.map((seller) => [seller, signals()]))));
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

  describe('verification status (live DIFF verdicts)', () => {
    function pricedPeer(peerId: string, services: string[]): PeerInfo {
      const peer = makePeer(peerId);
      peer.providerPricing = {
        openai: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }, services: Object.fromEntries(services.map((s) => [s, { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }])) },
      } as PeerInfo['providerPricing'];
      return peer;
    }

    function setup(readDiffServices: ReturnType<typeof vi.fn>) {
      const node = new AntseedNode({ role: 'buyer' });
      const agentOf: Record<string, number> = { ['a'.repeat(40)]: 7, ['b'.repeat(40)]: 8 };
      (node as any)._trustSignalsClient = trustClient(async (sellers: string[]) => new Map(sellers
        .filter((seller) => agentOf[seller.replace(/^0x/, '')] !== undefined)
        .map((seller) => [seller, signals({ agentId: agentOf[seller.replace(/^0x/, '')] })])));
      (node as any)._verificationSignalsClient = { readDiffServices };
      return node;
    }

    it('marks only the services with a live DIFF verdict, per seller', async () => {
      const readDiffServices = vi.fn(async () => new Map([[7, ['gpt-6.1-sol']], [8, []]]));
      const node = setup(readDiffServices);
      const a = pricedPeer('a'.repeat(40), ['GPT-6.1-Sol', 'claude-opus-5.5']);
      const b = pricedPeer('b'.repeat(40), ['gpt-6.1-sol']);
      const unregistered = pricedPeer('c'.repeat(40), ['gpt-6.1-sol']);

      await (node as any)._enrichPeersWithOnChainStats([a, b, unregistered]);

      expect(readDiffServices).toHaveBeenCalledTimes(1);
      expect(readDiffServices.mock.calls[0]![0]).toEqual([
        { agentId: 7, services: ['claude-opus-5.5', 'gpt-6.1-sol'] },
        { agentId: 8, services: ['gpt-6.1-sol'] },
      ]);
      expect(a.onChainDiffServices).toEqual(['gpt-6.1-sol']);
      expect(b.onChainDiffServices).toEqual([]);
      expect(unregistered.onChainDiffServices).toBeUndefined();
    });

    it('reuses a fresh read and refreshes after the TTL', async () => {
      const readDiffServices = vi.fn(async () => new Map([[7, ['gpt-6.1-sol']]]));
      const node = setup(readDiffServices);
      await (node as any)._enrichPeersWithOnChainStats([pricedPeer('a'.repeat(40), ['gpt-6.1-sol'])]);
      await (node as any)._enrichPeersWithOnChainStats([pricedPeer('a'.repeat(40), ['gpt-6.1-sol'])]);
      expect(readDiffServices).toHaveBeenCalledTimes(1);

      const cached = (node as any)._verificationStatusCache.get(7);
      cached.fetchedAt -= VERIFICATION_STATUS_TTL_MS + 1;
      await (node as any)._enrichPeersWithOnChainStats([pricedPeer('a'.repeat(40), ['gpt-6.1-sol'])]);
      expect(readDiffServices).toHaveBeenCalledTimes(2);
    });

    it('keeps the last good answer on a failed read, then fails open', async () => {
      const readDiffServices = vi.fn(async () => new Map([[7, ['gpt-6.1-sol']]]));
      const node = setup(readDiffServices);
      await (node as any)._enrichPeersWithOnChainStats([pricedPeer('a'.repeat(40), ['gpt-6.1-sol'])]);

      readDiffServices.mockRejectedValue(new Error('rpc down'));
      const cached = (node as any)._verificationStatusCache.get(7);
      cached.fetchedAt -= VERIFICATION_STATUS_TTL_MS + 1;
      const stillPenalized = pricedPeer('a'.repeat(40), ['gpt-6.1-sol']);
      await (node as any)._enrichPeersWithOnChainStats([stillPenalized]);
      expect(stillPenalized.onChainDiffServices).toEqual(['gpt-6.1-sol']);

      cached.fetchedAt -= VERIFICATION_STATUS_STALE_MAX_MS;
      const failedOpen = pricedPeer('a'.repeat(40), ['gpt-6.1-sol']);
      failedOpen.onChainDiffServices = ['gpt-6.1-sol'];
      await (node as any)._enrichPeersWithOnChainStats([failedOpen]);
      expect(failedOpen.onChainDiffServices).toBeUndefined();
    });
  });
});

import { describe, it, expect } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LocalRouter } from './router.js';

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: 'a'.repeat(40) as PeerInfo['peerId'],
    lastSeen: Date.now(),
    providers: ['anthropic'],
    reputationScore: 80,
    defaultInputUsdPerMillion: 10,
    defaultOutputUsdPerMillion: 10,
    providerPricing: {
      anthropic: {
        defaults: {
          inputUsdPerMillion: 10,
          outputUsdPerMillion: 10,
        },
      },
    },
    maxConcurrency: 10,
    currentLoad: 1,
    ...overrides,
  };
}

function makeRequest(service?: string): SerializedHttpRequest {
  const payload = service ? { model: service } : { messages: [{ role: 'user', content: 'hi' }] };
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(payload)),
  };
}

function withEstablishedHistory(peer: PeerInfo): PeerInfo {
  const now = Date.now();
  peer.verificationResults = { verified: true, checkedAtMs: now, domains: [],
    github: [{ username: 'portfolio', repository: 'proof', peerId: peer.peerId, verified: true, checkedAtMs: now }],
    identityHistory: { version: 1, identities: [{ kind: 'github', claim: 'portfolio', identityId: 'github:42',
      status: 'available', fetchedAtMs: now, createdAtMs: now - 10 * 365.25 * 86_400_000,
      projects: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, name: `project-${index}`,
        createdAtMs: now - 4 * 365.25 * 86_400_000, stars: 100, archived: false })) }] } };
  return peer;
}

describe('LocalRouter', () => {
  it('selects cheapest peer regardless of provider name', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const expensive = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providers: ['anthropic'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
        },
      },
      defaultInputUsdPerMillion: 100,
      defaultOutputUsdPerMillion: 100,
    });
    const cheap = makePeer({
      peerId: '2'.repeat(40) as PeerInfo['peerId'],
      providers: ['openai'],
      providerPricing: {
        openai: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
        },
      },
      defaultInputUsdPerMillion: 1,
      defaultOutputUsdPerMillion: 1,
    });

    const selected = router.selectPeer(makeRequest('claude-sonnet-4-5-20250929'), [expensive, cheap]);
    expect(selected?.peerId).toBe(cheap.peerId);
  });

  it('uses default minReputation of 0', () => {
    const router = new LocalRouter();
    const lowRep = makePeer({ reputationScore: 1 });
    expect(router.selectPeer(makeRequest(), [lowRep])?.peerId).toBe(lowRep.peerId);
  });

  it('rejects peers when output price exceeds buyer max even if input is within max', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 10 },
      },
    });

    const overpricedOutputPeer = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 20 },
        },
      },
      defaultInputUsdPerMillion: 5,
      defaultOutputUsdPerMillion: 20,
    });

    expect(router.selectPeer(makeRequest('claude-sonnet-4-5-20250929'), [overpricedOutputPeer])).toBeNull();
  });

  it('rejects peers when cached input price exceeds input price', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 50 },
      },
    });

    const invalidCachedPricePeer = makePeer({
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 20, cachedInputUsdPerMillion: 6 },
        },
      },
    });

    expect(router.selectPeer(makeRequest(), [invalidCachedPricePeer])).toBeNull();
  });

  it('rejects peers when cached input price exceeds buyer cached max', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 50, cachedInputUsdPerMillion: 2 },
      },
    });

    const expensiveCachedInputPeer = makePeer({
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 20, cachedInputUsdPerMillion: 3 },
        },
      },
    });

    expect(router.selectPeer(makeRequest(), [expensiveCachedInputPeer])).toBeNull();
  });

  it('checks pricing-only and full pinned-peer policies separately', () => {
    const router = new LocalRouter({
      minReputation: 70,
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 50 },
      },
    });
    const lowRepAllowedPrice = makePeer({
      reputationScore: 1,
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
        },
      },
    });
    const highRepAllowedPrice = withEstablishedHistory(makePeer({
      reputationScore: 90,
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
        },
      },
    }));
    const highRepOverpriced = makePeer({
      reputationScore: 90,
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 100 },
        },
      },
    });

    expect(router.selectPeer(makeRequest(), [lowRepAllowedPrice])).toBeNull();
    expect(router.allowsPeerForPricing(makeRequest(), lowRepAllowedPrice)).toBe(true);
    expect(router.allowsPeerForPolicy(makeRequest(), lowRepAllowedPrice)).toBe(false);
    expect(router.allowsPeerForPolicy(makeRequest(), highRepAllowedPrice)).toBe(true);
    expect(router.allowsPeerForPolicy(makeRequest(), highRepOverpriced)).toBe(false);
  });

  it('uses service-specific seller offer pricing when request service is present', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const peerA = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 },
          services: {
            'service-a': { inputUsdPerMillion: 90, outputUsdPerMillion: 90 },
          },
        },
      },
      defaultInputUsdPerMillion: 10,
      defaultOutputUsdPerMillion: 10,
    });
    const peerB = makePeer({
      peerId: '2'.repeat(40) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 20, outputUsdPerMillion: 20 },
          services: {
            'service-a': { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
          },
        },
      },
      defaultInputUsdPerMillion: 20,
      defaultOutputUsdPerMillion: 20,
    });

    const selected = router.selectPeer(makeRequest('service-a'), [peerA, peerB]);
    expect(selected?.peerId).toBe(peerB.peerId);
  });

  it('falls back to provider defaults when request service is absent', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 1_000, outputUsdPerMillion: 1_000 },
      },
    });

    const expensiveDefault = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 40, outputUsdPerMillion: 40 },
          services: {
            'service-a': { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          },
        },
      },
      defaultInputUsdPerMillion: 40,
      defaultOutputUsdPerMillion: 40,
    });
    const cheapDefault = makePeer({
      peerId: '2'.repeat(40) as PeerInfo['peerId'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 },
        },
      },
      defaultInputUsdPerMillion: 5,
      defaultOutputUsdPerMillion: 5,
    });

    const selected = router.selectPeer(makeRequest(undefined), [expensiveDefault, cheapDefault]);
    expect(selected?.peerId).toBe(cheapDefault.peerId);
  });

  it('puts peers on cooldown after failure threshold and re-allows them later', () => {
    let now = 1_000_000;
    const router = new LocalRouter({
      maxFailures: 2,
      failureCooldownMs: 500,
      now: () => now,
    });

    const flaky = makePeer({ peerId: '1'.repeat(40) as PeerInfo['peerId'], lastSeen: now });
    const fallback = makePeer({ peerId: 'f'.repeat(40) as PeerInfo['peerId'], lastSeen: now });

    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });
    router.onResult(flaky, { success: false, latencyMs: 300, tokens: 0 });

    // Flaky is cooling down; fallback should be selected.
    expect(router.selectPeer(makeRequest(), [flaky, fallback])?.peerId).toBe(fallback.peerId);

    now += 501;
    // Cooldown expired; flaky is allowed again, but still penalized by reliability history.
    expect(router.selectPeer(makeRequest(), [flaky, fallback])?.peerId).toBe(fallback.peerId);
    // It should still be selectable when no alternatives exist.
    expect(router.selectPeer(makeRequest(), [flaky])?.peerId).toBe(flaky.peerId);
  });

  it('filters out peers below minimum reputation', () => {
    const router = new LocalRouter({
      minReputation: 70,
    });

    const lowRep = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      reputationScore: 40,
    });
    const highRep = makePeer({
      peerId: '2'.repeat(40) as PeerInfo['peerId'],
      reputationScore: 90,
    });
    withEstablishedHistory(highRep);

    const selected = router.selectPeer(makeRequest(), [lowRep, highRep]);
    expect(selected?.peerId).toBe(highRep.peerId);
  });

  it('keeps peers eligible when reputation fields are missing and minimum is zero', () => {
    const router = new LocalRouter();
    const unrated = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      reputationScore: undefined,
      onChainChannelCount: undefined,
    });

    const selected = router.selectPeer(makeRequest(), [unrated]);
    expect(selected?.peerId).toBe(unrated.peerId);
  });

  it('filters missing reputation when minimum is raised', () => {
    const router = new LocalRouter({ minReputation: 1 });
    const unrated = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      reputationScore: undefined,
      onChainChannelCount: undefined,
    });

    expect(router.selectPeer(makeRequest(), [unrated])).toBeNull();
  });

  it('treats on-chain zero reputation with zero sessions as unrated', () => {
    const router = new LocalRouter();
    const newSeller = makePeer({
      peerId: '3'.repeat(40) as PeerInfo['peerId'],
      reputationScore: undefined,
      onChainChannelCount: 0,
      onChainGhostCount: 0,
    });

    const selected = router.selectPeer(makeRequest(), [newSeller]);
    expect(selected?.peerId).toBe(newSeller.peerId);
  });

  it('ignores empty provider entries when selecting a peer provider', () => {
    const router = new LocalRouter();
    const malformedProviders = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providers: ['', 'anthropic'],
    });

    const selected = router.selectPeer(makeRequest(), [malformedProviders]);
    expect(selected?.peerId).toBe(malformedProviders.peerId);
  });

  it('selects correct provider for pricing on multi-provider peer', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: { inputUsdPerMillion: 50, outputUsdPerMillion: 50 },
      },
    });

    // Peer has two providers: anthropic (expensive) and openai (cheap)
    const multiPeer = makePeer({
      peerId: '1'.repeat(40) as PeerInfo['peerId'],
      providers: ['anthropic', 'openai'],
      providerPricing: {
        anthropic: {
          defaults: { inputUsdPerMillion: 100, outputUsdPerMillion: 100 },
          services: { 'claude-sonnet-4-5-20250929': { inputUsdPerMillion: 100, outputUsdPerMillion: 100 } },
        },
        openai: {
          defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 },
          services: { 'gpt-4o': { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
        },
      },
      defaultInputUsdPerMillion: 100,
      defaultOutputUsdPerMillion: 100,
    });

    // Requesting gpt-4o should use openai pricing (10), not anthropic (100 > max 50)
    const selected = router.selectPeer(makeRequest('gpt-4o'), [multiPeer]);
    expect(selected?.peerId).toBe(multiPeer.peerId);
  });

  it('returns null when no peers are available', () => {
    const router = new LocalRouter();
    expect(router.selectPeer(makeRequest(), [])).toBeNull();
  });
});

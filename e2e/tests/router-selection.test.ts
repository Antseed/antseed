import { describe, it, expect } from 'vitest';
import type { PeerInfo, SerializedHttpRequest } from '@antseed/node';
import { LocalRouter } from '../../plugins/router-local/src/router.js';

function makePeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    peerId: 'a'.repeat(40) as any,
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

const dummyReq: SerializedHttpRequest = {
  requestId: 'req-1',
  method: 'POST',
  path: '/v1/messages',
  headers: { 'content-type': 'application/json' },
  body: new Uint8Array(),
};

describe('LocalRouter peer selection hardening', () => {
  it('prefers fresher peers when other signals are equal', () => {
    let now = 1_000_000;
    const router = new LocalRouter({
      now: () => now,
      maxPeerStalenessMs: 1_000,
    });

    const fresh = makePeer({ peerId: 'a'.repeat(40) as any, lastSeen: now });
    const stale = makePeer({ peerId: 'b'.repeat(40) as any, lastSeen: now - 1_000 });

    const selected = router.selectPeer(dummyReq, [stale, fresh]);
    expect(selected?.peerId).toBe(fresh.peerId);
  });

  it('places unstable peers on cooldown and then re-allows them after cooldown', () => {
    let now = 2_000_000;
    const router = new LocalRouter({
      maxFailures: 2,
      failureCooldownMs: 1_000,
      now: () => now,
    });
    const peer = makePeer({ peerId: 'c'.repeat(40) as any, lastSeen: now });

    // Single peer should be selected initially.
    expect(router.selectPeer(dummyReq, [peer])?.peerId).toBe(peer.peerId);

    router.onResult(peer, { success: false, latencyMs: 500, tokens: 0 });
    router.onResult(peer, { success: false, latencyMs: 500, tokens: 0 });
    // During cooldown the peer should be excluded.
    expect(router.selectPeer(dummyReq, [peer])).toBeNull();

    now += 1_001;
    // After cooldown expiry, the peer is selectable again.
    expect(router.selectPeer(dummyReq, [peer])?.peerId).toBe(peer.peerId);
  });

  it('rotates equal-scored peers instead of pinning the lowest peer id', () => {
    const router = new LocalRouter();
    const lowIdPeer = makePeer({ peerId: '1'.repeat(40) as any, lastSeen: 1_000_000 });
    const highIdPeer = makePeer({ peerId: 'f'.repeat(40) as any, lastSeen: 1_000_000 });

    const first = router.selectPeer(dummyReq, [highIdPeer, lowIdPeer]);
    const second = router.selectPeer(dummyReq, [highIdPeer, lowIdPeer]);
    expect(new Set([first?.peerId, second?.peerId])).toEqual(new Set([lowIdPeer.peerId, highIdPeer.peerId]));
    expect(first?.peerId).not.toBe(second?.peerId);
  });

  it('falls back to provider defaults for unknown service instead of rejecting peer', () => {
    const router = new LocalRouter({
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 20,
          outputUsdPerMillion: 20,
        },
      },
    });

    const peer = makePeer({
      providerPricing: {
        anthropic: {
          defaults: {
            inputUsdPerMillion: 5,
            outputUsdPerMillion: 5,
          },
          services: {
            'known-service': {
              inputUsdPerMillion: 7,
              outputUsdPerMillion: 7,
            },
          },
        },
      },
      defaultInputUsdPerMillion: 5,
      defaultOutputUsdPerMillion: 5,
    });

    const reqUnknownService: SerializedHttpRequest = {
      ...dummyReq,
      body: new TextEncoder().encode(JSON.stringify({ model: 'unknown-service' })),
    };

    const selected = router.selectPeer(reqUnknownService, [peer]);
    expect(selected?.peerId).toBe(peer.peerId);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import { PeerAnnouncer, type AnnouncerConfig } from '../src/discovery/announcer.js';
import { encodeMetadataForSigning } from '../src/discovery/metadata-codec.js';
import { ANTSEED_WILDCARD_TOPIC, peerTopic, subnetOf, subnetTopic, topicToInfoHash } from '../src/discovery/dht-node.js';
import { verifySignature, bytesToHex, hexToBytes } from '../src/p2p/identity.js';
import { toPeerId } from '../src/types/peer.js';

function makeConfig(): { config: AnnouncerConfig; dht: { announce: ReturnType<typeof vi.fn> } } {
  const privateKey = randomBytes(32);
  const wallet = new Wallet('0x' + bytesToHex(privateKey));
  const peerId = toPeerId(wallet.address.slice(2).toLowerCase());

  const dht = {
    announce: vi.fn().mockResolvedValue(undefined),
  };

  const config: AnnouncerConfig = {
    identity: {
      peerId,
      privateKey,
      wallet,
    },
    dht: dht as unknown as AnnouncerConfig['dht'],
    providers: [
      {
        provider: 'anthropic',
        services: ['claude-sonnet'],
        maxConcurrency: 5,
      },
    ],
    region: 'us',
    pricing: new Map([
      ['anthropic', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]),
    reannounceIntervalMs: 30_000,
    signalingPort: 6882,
  };

  return { config, dht };
}

describe('PeerAnnouncer live load metadata', () => {
  it('refreshes signed metadata load without re-announcing to DHT', async () => {
    const { config, dht } = makeConfig();
    const announcer = new PeerAnnouncer(config);

    await announcer.announce();
    const first = announcer.getLatestMetadata();
    expect(first).not.toBeNull();
    expect(first!.providers[0]!.currentLoad).toBe(0);
    expect(dht.announce).toHaveBeenCalled();

    dht.announce.mockClear();
    announcer.updateLoad('anthropic', 3);
    await announcer.refreshMetadata();

    const refreshed = announcer.getLatestMetadata();
    expect(refreshed).not.toBeNull();
    expect(refreshed!.providers[0]!.currentLoad).toBe(3);
    expect(dht.announce).not.toHaveBeenCalled();

    const valid = verifySignature(
      refreshed!.peerId,
      hexToBytes(refreshed!.signature),
      encodeMetadataForSigning(refreshed!),
    );
    expect(valid).toBe(true);
  });

  it('preserves wildcard service metadata entries when provider services are wildcard', async () => {
    const { config } = makeConfig();
    config.providers = [
      {
        provider: 'openai',
        services: [],
        serviceCategories: {
          'gpt-4.1': [' Coding ', 'coding'],
        },
        serviceApiProtocols: {
          'gpt-4.1': ['openai-chat-completions', 'OPENAI-CHAT-COMPLETIONS' as any, 'invalid-protocol' as any],
        },
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.refreshMetadata();
    const refreshed = announcer.getLatestMetadata();
    expect(refreshed).not.toBeNull();
    expect(refreshed!.providers[0]!.serviceCategories).toEqual({
      'gpt-4.1': ['coding'],
    });
    expect(refreshed!.providers[0]!.serviceApiProtocols).toEqual({
      'gpt-4.1': ['openai-chat-completions'],
    });
  });

  it('announces only subnet, wildcard, and per-peer topics — never service topics', async () => {
    const { config, dht } = makeConfig();
    config.providers = [
      {
        provider: 'openai',
        services: ['KIMI2.5', 'kimi2.5', 'KIMI-2.5'],
        maxConcurrency: 5,
      },
    ];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    const announcer = new PeerAnnouncer(config);
    await announcer.announce();

    // Subnet + wildcard + per-peer = 3, regardless of how many services or
    // casing variants the seller advertises. Service-level DHT topics were
    // intentionally retired — the signed metadata is the source of truth
    // for service filtering, and announce work no longer scales with the
    // service catalog.
    expect(dht.announce).toHaveBeenCalledTimes(3);
    const announcedHashes = new Set(
      dht.announce.mock.calls.map(([hash]) => (hash as Buffer).toString('hex')),
    );
    expect(announcedHashes).toEqual(new Set([
      topicToInfoHash(subnetTopic(subnetOf(config.identity.peerId))).toString('hex'),
      topicToInfoHash(ANTSEED_WILDCARD_TOPIC).toString('hex'),
      topicToInfoHash(peerTopic(config.identity.peerId)).toString('hex'),
    ]));
    // Sanity-check the strings: nothing announced should look like a service topic.
    for (const call of dht.announce.mock.calls) {
      // The hash is opaque, so we re-derive each candidate from its source string.
      const hashHex = (call[0] as Buffer).toString('hex');
      expect(hashHex).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  it('keeps announce work O(1) in the seller\'s service count', async () => {
    // Property-style: announcing N services must produce the same number of
    // DHT announces as announcing 1, because service filtering is metadata
    // driven. Keep generated catalogs inside the signed metadata validator's
    // service-count limit so this test stays focused on DHT work.
    for (const n of [1, 100, 512]) {
      const { config, dht } = makeConfig();
      config.providers = [{
        provider: 'openai',
        services: Array.from({ length: n }, (_, i) => `service-${i}`),
        maxConcurrency: 5,
      }];
      config.pricing = new Map([
        ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
      ]);

      const announcer = new PeerAnnouncer(config);
      await announcer.announce();

      // Always 3 — subnet + wildcard + per-peer. Capabilities aren't configured here.
      expect(dht.announce).toHaveBeenCalledTimes(3);
    }
  });

  it('announces topics in parallel rather than sequentially', async () => {
    // Parallel announce is what makes the cycle time bounded by the slowest
    // single announce instead of summed across all of them. Verify by
    // watching how many announces are in flight at the moment any single
    // call resolves — with a sequential implementation it'd always be 1.
    const { config } = makeConfig();
    config.providers = [{
      provider: 'openai',
      services: ['svc'],
      maxConcurrency: 5,
    }];
    config.pricing = new Map([
      ['openai', { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } }],
    ]);

    let inFlight = 0;
    let peakInFlight = 0;
    const announce = vi.fn(async () => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    });
    config.dht = { announce } as unknown as AnnouncerConfig['dht'];

    const announcer = new PeerAnnouncer(config);
    await announcer.announce();

    expect(announce).toHaveBeenCalledTimes(3);
    expect(peakInFlight).toBe(3);
  });
});

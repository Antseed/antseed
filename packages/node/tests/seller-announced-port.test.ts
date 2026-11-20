import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { DHTNode, sellerTopics, topicToInfoHash } from '../src/discovery/dht-node.js';
import { HttpMetadataResolver } from '../src/discovery/http-metadata-resolver.js';
import { ConnectionManager } from '../src/p2p/connection-manager.js';
import { identityFromPrivateKeyHex } from '../src/p2p/identity.js';
import { NatTraversal } from '../src/p2p/nat-traversal.js';

describe('seller DHT signaling port', () => {
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { publicAddress: '198.51.100.20:14532', publicPort: 14532 },
    { publicAddress: 'seller.example.com:14532', publicPort: 14532 },
    { publicAddress: undefined, publicPort: undefined },
  ])('announces the bound port and any different public port for $publicAddress', async ({ publicAddress, publicPort }) => {
    const dataDir = mkdtempSync(join(tmpdir(), 'antseed-announce-public-port-'));
    const identity = identityFromPrivateKeyHex('11'.repeat(32));
    const manager = new ConnectionManager();
    // Keep discovery and NAT traffic off the public network; use a real TCP listener and metadata server.
    vi.spyOn(ConnectionManager, 'init').mockResolvedValue(manager);
    const announce = vi.spyOn(DHTNode.prototype, 'announce').mockResolvedValue(undefined);
    const mapPorts = vi.spyOn(NatTraversal.prototype, 'mapPorts').mockResolvedValue({
      success: false, externalIp: null, mappings: [],
    });
    const node = new AntseedNode({
      role: 'seller',
      dataDir,
      identity,
      noOfficialBootstrap: true,
      dhtPort: 0,
      signalingPort: 0,
      publicAddress,
    });
    node.registerProvider({
      name: 'openai',
      services: ['test-model'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      maxConcurrency: 1,
      getCapacity: () => ({ current: 0, max: 1 }),
      handleRequest: async () => { throw new Error('No inference expected'); },
    });

    try {
      await node.start();

      const boundPort = node.signalingPort;
      expect(boundPort).toBeGreaterThan(0);
      if (publicPort !== undefined) expect(boundPort).not.toBe(publicPort);
      const topics = sellerTopics(identity.peerId);
      const ports = publicPort === undefined ? [boundPort] : [boundPort, publicPort];
      await vi.waitFor(() => expect(announce).toHaveBeenCalledTimes(topics.length * ports.length));
      for (const topic of topics) {
        for (const port of ports) {
          expect(announce).toHaveBeenCalledWith(topicToInfoHash(topic), port);
        }
      }
      expect(mapPorts).toHaveBeenCalledWith([
        { port: boundPort, protocol: 'TCP' },
        { port: node.dhtPort, protocol: 'UDP' },
      ]);

      const metadata = await new HttpMetadataResolver().resolve({ host: '127.0.0.1', port: boundPort });
      expect(metadata?.peerId).toBe(node.peerId);
      expect(metadata?.publicAddress).toBe(publicAddress);
    } finally {
      await manager.stopListening();
      await node.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('seller announced prices', () => {
  afterEach(() => vi.restoreAllMocks());

  it('announces every default price it bills by, the cached-input price included', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'antseed-announce-pricing-'));
    const manager = new ConnectionManager();
    vi.spyOn(ConnectionManager, 'init').mockResolvedValue(manager);
    vi.spyOn(DHTNode.prototype, 'announce').mockResolvedValue(undefined);
    vi.spyOn(NatTraversal.prototype, 'mapPorts').mockResolvedValue({ success: false, externalIp: null, mappings: [] });
    const node = new AntseedNode({
      role: 'seller',
      dataDir,
      identity: identityFromPrivateKeyHex('12'.repeat(32)),
      noOfficialBootstrap: true,
      dhtPort: 0,
      signalingPort: 0,
    });
    const provider = (name: string, defaults: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }) => ({
      name,
      services: ['test-model', 'priced-model'],
      pricing: { defaults, services: { 'priced-model': { inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.5 } } },
      maxConcurrency: 1,
      getCapacity: () => ({ current: 0, max: 1 }),
      handleRequest: async () => { throw new Error('No inference expected'); },
    });
    node.registerProvider(provider('cached-priced', { inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.75 }));
    node.registerProvider(provider('no-cached-price', { inputUsdPerMillion: 1, outputUsdPerMillion: 2 }));

    try {
      await node.start();
      const metadata = await new HttpMetadataResolver().resolve({ host: '127.0.0.1', port: node.signalingPort });
      const announced = Object.fromEntries((metadata?.providers ?? []).map((entry) => [entry.provider, entry]));
      expect(announced['cached-priced']?.defaultPricing).toEqual({ inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.75 });
      expect(announced['no-cached-price']?.defaultPricing).toEqual({ inputUsdPerMillion: 1, outputUsdPerMillion: 2 });
      expect(announced['cached-priced']?.servicePricing?.['priced-model']).toEqual({ inputUsdPerMillion: 3, outputUsdPerMillion: 15, cachedInputUsdPerMillion: 0.5 });
    } finally {
      await manager.stopListening();
      await node.stop();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

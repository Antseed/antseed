import { describe, expect, it, vi } from 'vitest';
import { DHTNode, DEFAULT_DHT_CONFIG } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

// Real UDP4 sockets and the default OS resolver, with no public-network peers.
describe('localhost DHT bootstrap', () => {
  it('populates a routing table using localhost with the default IPv4 resolver', async () => {
    const seed = new DHTNode({
      ...DEFAULT_DHT_CONFIG,
      peerId: toPeerId('a'.repeat(40)),
      port: 0,
      bootstrapNodes: [],
      operationTimeoutMs: 1000,
      allowPrivateIPs: true,
    });
    let buyer: DHTNode | undefined;
    try {
      await seed.start();
      expect(seed.getPort()).toBeGreaterThan(0);
      buyer = new DHTNode({
        ...DEFAULT_DHT_CONFIG,
        peerId: toPeerId('b'.repeat(40)),
        port: 0,
        bootstrapNodes: [{ host: 'localhost', port: seed.getPort() }],
        operationTimeoutMs: 1000,
        allowPrivateIPs: true,
      });
      await buyer.start();
      const connectedBuyer = buyer;
      await vi.waitFor(() => expect(connectedBuyer.getNodeCount()).toBeGreaterThan(0), {
        timeout: 3000, interval: 25,
      });
    } finally {
      await buyer?.stop();
      await seed.stop();
    }
  }, 10_000);
});

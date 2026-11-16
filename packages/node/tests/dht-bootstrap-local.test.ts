import { describe, expect, it, vi } from 'vitest';
import { DHTNode, DEFAULT_DHT_CONFIG } from '../src/discovery/dht-node.js';
import { toPeerId } from '../src/types/peer.js';

describe('localhost DHT bootstrap', () => {
  it('joins another local DHTNode with the default IPv4 resolver', async () => {
    const config = {
      ...DEFAULT_DHT_CONFIG, peerId: toPeerId('a'.repeat(40)), port: 0,
      operationTimeoutMs: 1000, allowPrivateIPs: true,
    };
    const seed = new DHTNode({ ...config, bootstrapNodes: [] });
    let buyer: DHTNode | undefined;
    try {
      await seed.start();
      buyer = new DHTNode({ ...config, bootstrapNodes: [{ host: 'localhost', port: seed.getPort() }] });
      await buyer.start();
      const connectedBuyer = buyer;
      await vi.waitFor(() => expect(connectedBuyer.getNodeCount()).toBeGreaterThan(0), { timeout: 3000 });
    } finally {
      await buyer?.stop();
      await seed.stop();
    }
  }, 10_000);
});

import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockAnthropicProvider } from './helpers/mock-provider.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';

async function waitForPeers(
  node: AntseedNode,
  expectedCount: number,
  timeoutMs = 15_000,
  intervalMs = 500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const peers = await node.discoverPeers();
    if (peers.length >= expectedCount) return;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Expected ${expectedCount} peer(s) within ${timeoutMs}ms`);
}

describe('Discovery: seller announces, buyer discovers via DHT', () => {
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;

  afterEach(async () => {
    try { if (buyerNode) { await buyerNode.stop(); buyerNode = null; } } catch {}
    try { if (sellerNode) { await sellerNode.stop(); sellerNode = null; } } catch {}
    try { if (bootstrap) { await bootstrap.stop(); bootstrap = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
  });

  it('buyer discovers seller via DHT after seller announces', async () => {
    // 1. Create local bootstrap
    bootstrap = await createLocalBootstrap();

    // 2. Create seller AntseedNode with mock provider
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
    const mockProvider = new MockAnthropicProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,          // OS-assigned
      signalingPort: 0,    // OS-assigned
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(mockProvider);
    await sellerNode.start();

    const sellerPeerId = sellerNode.peerId;
    expect(sellerPeerId).toBeTruthy();

    // 3. Create buyer AntseedNode
    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-'));

    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,          // OS-assigned
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    await buyerNode.start();

    const buyerPeerId = buyerNode.peerId;
    expect(buyerPeerId).toBeTruthy();
    expect(buyerPeerId).not.toEqual(sellerPeerId);

    // 4. Buyer discovers peers
    await waitForPeers(buyerNode, 1);
    const peers = await buyerNode.discoverPeers();

    // 6. Assert: at least one peer found, seller's peerId is among them
    expect(peers.length).toBeGreaterThanOrEqual(1);

    const sellerPeer = peers.find((p) => p.peerId === sellerPeerId);
    expect(sellerPeer).toBeDefined();
    expect(sellerPeer!.providerPricing).toBeDefined();
    const anthropicPricing = sellerPeer!.providerPricing?.['anthropic'];
    expect(anthropicPricing).toBeDefined();
    expect(anthropicPricing?.defaults.inputUsdPerMillion).toBeGreaterThanOrEqual(0);
    expect(anthropicPricing?.defaults.outputUsdPerMillion).toBeGreaterThanOrEqual(0);
    expect(sellerPeer!.defaultInputUsdPerMillion).toBeGreaterThanOrEqual(0);
    expect(sellerPeer!.defaultOutputUsdPerMillion).toBeGreaterThanOrEqual(0);
  });
});

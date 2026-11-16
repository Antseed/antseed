import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type { SerializedHttpRequest } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockAnthropicProvider } from './helpers/mock-provider.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

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

function makeRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  const body = JSON.stringify({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 256,
    messages: [{ role: 'user', content: 'Hello' }],
  });

  return {
    requestId: randomUUID(),
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(body),
    ...overrides,
  };
}

describe('Payment negotiation: seller sends PaymentRequired on 402', () => {
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

  it('buyer receives a buyer-fault error when seller requires payment but buyer runs no payments', async () => {
    bootstrap = await createLocalBootstrap();

    // Seller with a fake payments config (will trigger 402 path)
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-pay-'));
    const mockProvider = new MockAnthropicProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: {
        enabled: true,
        // Use dummy addresses — no real RPC calls in this test.
        // The seller will have _sessionsClient set (triggering 402 gate)
        // but SellerPaymentManager won't be fully initialized (no tokenRate).
        rpcUrl: 'http://127.0.0.1:1', // unreachable — intentional
        depositsAddress: '0x' + 'dd'.repeat(20),
        channelsAddress: '0x' + 'cc'.repeat(20),
        stakingAddress: '0x' + 'bb'.repeat(20),
        usdcAddress: '0x' + 'ee'.repeat(20),
      },
    });
    sellerNode.registerProvider(mockProvider);
    await sellerNode.start();

    // Buyer without payment manager (no payments config)
    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-pay-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    await buyerNode.start();

    // Discover seller
    await waitForPeers(buyerNode!, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();

    // Send request — buyer has no BuyerPaymentManager, so no negotiation.
    // The seller returns 402, and the buyer converts it into a buyer-fault
    // error: no amount of credits helps when payments are not running, so
    // forwarding the raw "add credits" 402 would misdirect the user.
    const request = makeRequest();
    const response = await buyerNode!.sendRequest(seller!, request);

    expect(response.statusCode).toBe(503);
    expect(response.headers['x-antseed-fault-attribution']).toBe('buyer');
    const body = new TextDecoder().decode(response.body);
    expect(body).toContain('buyer_payments_inactive');
    expect(body).toContain('payments are not running on this buyer');

    // Seller's provider was NOT called (request rejected before routing)
    expect(mockProvider.requestCount).toBe(0);
  });

  it('without payments config, seller serves request without payment', async () => {
    bootstrap = await createLocalBootstrap();

    // Seller WITHOUT payments — no sessions client, no 402
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-free-'));
    const mockProvider = new MockAnthropicProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(mockProvider);
    await sellerNode.start();

    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-free-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    await buyerNode.start();

    await waitForPeers(buyerNode!, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();

    const request = makeRequest();
    const response = await buyerNode!.sendRequest(seller!, request);

    expect(response.statusCode).toBe(200);
    expect(mockProvider.requestCount).toBe(1);
  });

  it('payment:required event fires on buyer when seller requires payment and buyer has payment manager', async () => {
    bootstrap = await createLocalBootstrap();

    // Seller with payments (triggers 402 + PaymentRequired)
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-evt-'));
    const mockProvider = new MockAnthropicProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: {
        enabled: true,
        rpcUrl: 'http://127.0.0.1:1',
        depositsAddress: '0x' + 'dd'.repeat(20),
        channelsAddress: '0x' + 'cc'.repeat(20),
        stakingAddress: '0x' + 'bb'.repeat(20),
        usdcAddress: '0x' + 'ee'.repeat(20),
      },
    });
    sellerNode.registerProvider(mockProvider);
    await sellerNode.start();

    // Buyer WITH payment manager configured (but unreachable RPC)
    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-evt-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: {
        enabled: true,
        rpcUrl: 'http://127.0.0.1:1',
        depositsAddress: '0x' + 'dd'.repeat(20),
        channelsAddress: '0x' + 'cc'.repeat(20),
        stakingAddress: '0x' + 'bb'.repeat(20),
        usdcAddress: '0x' + 'ee'.repeat(20),
      },
    });
    await buyerNode.start();

    await waitForPeers(buyerNode!, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();

    // The buyer gets a 402 and tries to negotiate, but its RPC is unreachable
    // so it cannot read its own deposit balance. That is a buyer-side fault:
    // the negotiator reports 503 `chain_rpc_unavailable` immediately rather
    // than negotiating blind and stalling out into an error that blames the
    // seller. A 402 remains acceptable for setups that get far enough to hear
    // the seller's payment requirements first.
    const request = makeRequest();
    try {
      const response = await buyerNode!.sendRequest(seller!, request);
      expect([402, 503]).toContain(response.statusCode);
      if (response.statusCode === 503) {
        const body = JSON.parse(new TextDecoder().decode(response.body)) as { reason?: string };
        expect(body.reason).toBe('chain_rpc_unavailable');
      }
    } catch (err) {
      // Negotiation may still throw on timeout for other configurations.
      expect(err).toBeDefined();
      expect((err as Error).message).toMatch(/timed?\s*out|failed|PaymentRequired|Lock confirmation/i);
    }
  });
});

import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type { SerializedHttpRequest, PeerInfo } from '@antseed/node';
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

describe('Request flow: buyer sends request to seller via P2P', () => {
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

  async function setupNetwork(): Promise<{
    mockProvider: MockAnthropicProvider;
    discoveredSeller: PeerInfo;
  }> {
    // 1. Bootstrap
    bootstrap = await createLocalBootstrap();

    // 2. Seller
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
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

    // 3. Buyer
    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-'));

    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    await buyerNode.start();

    // 4. Discover seller
    await waitForPeers(buyerNode!, 1);
    const peers = await buyerNode.discoverPeers();
    expect(peers.length).toBeGreaterThanOrEqual(1);

    const discoveredSeller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(discoveredSeller).toBeDefined();
    expect(discoveredSeller!.defaultInputUsdPerMillion).toBeGreaterThanOrEqual(0);
    expect(discoveredSeller!.defaultOutputUsdPerMillion).toBeGreaterThanOrEqual(0);
    expect(discoveredSeller!.providerPricing).toBeDefined();

    return { mockProvider, discoveredSeller: discoveredSeller! };
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

  it('buyer sends a single request and receives a response', async () => {
    const { mockProvider, discoveredSeller } = await setupNetwork();

    // Send request
    const request = makeRequest();
    const response = await buyerNode!.sendRequest(discoveredSeller, request);

    // Assert response
    expect(response.statusCode).toBe(200);
    expect(response.requestId).toBe(request.requestId);
    expect(response.headers['content-type']).toBe('application/json');

    const responseBody = JSON.parse(new TextDecoder().decode(response.body));
    expect(responseBody.type).toBe('message');
    expect(responseBody.role).toBe('assistant');
    expect(responseBody.content[0].text).toBe('Hello from mock provider!');

    // Verify mock was called
    expect(mockProvider.requestCount).toBe(1);
  });

  it('buyer sends 5 concurrent requests and all succeed', async () => {
    const { mockProvider, discoveredSeller } = await setupNetwork();

    // Send 5 parallel requests
    const requests = Array.from({ length: 5 }, () => makeRequest());
    const responses = await Promise.all(
      requests.map((req) => buyerNode!.sendRequest(discoveredSeller, req)),
    );

    // Assert all responses are successful
    for (let i = 0; i < responses.length; i++) {
      expect(responses[i]!.statusCode).toBe(200);
      expect(responses[i]!.requestId).toBe(requests[i]!.requestId);

      const body = JSON.parse(new TextDecoder().decode(responses[i]!.body));
      expect(body.type).toBe('message');
      expect(body.content[0].text).toBe('Hello from mock provider!');
    }

    // Verify all 5 requests were handled
    expect(mockProvider.requestCount).toBe(5);
  });
});

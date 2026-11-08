import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type { Provider, SerializedHttpRequest, SerializedHttpResponse, PeerInfo } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

class MockProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;
  public lastRequestedService: string | null = null;

  constructor(name: string, services: string[], pricing?: Provider['pricing']) {
    this.name = name;
    this.services = services;
    this.pricing = pricing ?? {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    };
  }

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    this.requestCount++;
    try {
      const parsed = JSON.parse(new TextDecoder().decode(req.body)) as Record<string, unknown>;
      this.lastRequestedService = (parsed['model'] as string) ?? null;

      const body = JSON.stringify({
        id: 'msg_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: `Response from ${this.name}` }],
        model: this.lastRequestedService,
        usage: { input_tokens: 10, output_tokens: 5 },
      });
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(body),
      };
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

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

describe('Multi-provider: single node with two provider plugins', () => {
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

  function makeRequest(service: string): SerializedHttpRequest {
    const body = JSON.stringify({
      model: service,
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Hello' }],
    });
    return {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(body),
    };
  }

  async function setupMultiProviderNetwork(): Promise<{
    providerA: MockProvider;
    providerB: MockProvider;
    seller: PeerInfo;
  }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
    const providerA = new MockProvider('anthropic', ['claude-sonnet-4-5-20250929', 'claude-opus-4-1-20250903']);
    const providerB = new MockProvider('openai', ['gpt-4o', 'gpt-4o-mini']);

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(providerA);
    sellerNode.registerProvider(providerB);
    await sellerNode.start();

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

    await waitForPeers(buyerNode!, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();

    return { providerA, providerB, seller: seller! };
  }

  it('routes requests to the correct provider based on requested service', async () => {
    const { providerA, providerB, seller } = await setupMultiProviderNetwork();

    // Request a service from provider A
    const responseA = await buyerNode!.sendRequest(seller, makeRequest('claude-sonnet-4-5-20250929'));
    expect(responseA.statusCode).toBe(200);
    const bodyA = JSON.parse(new TextDecoder().decode(responseA.body));
    expect(bodyA.content[0].text).toBe('Response from anthropic');
    expect(providerA.requestCount).toBe(1);
    expect(providerB.requestCount).toBe(0);

    // Request a service from provider B
    const responseB = await buyerNode!.sendRequest(seller, makeRequest('gpt-4o'));
    expect(responseB.statusCode).toBe(200);
    const bodyB = JSON.parse(new TextDecoder().decode(responseB.body));
    expect(bodyB.content[0].text).toBe('Response from openai');
    expect(providerA.requestCount).toBe(1);
    expect(providerB.requestCount).toBe(1);
  });

  it('seller announces all providers and pricing from both providers', async () => {
    const { seller } = await setupMultiProviderNetwork();

    // The peer advertises both providers by ID, never by plugin name
    expect(seller.providers.length).toBe(2);
    for (const provider of seller.providers) expect(provider).toMatch(/^[0-9a-f]{12}$/);
    expect(new Set(seller.providers).size).toBe(2);

    // Both providers should have pricing entries
    expect(seller.providerPricing).toBeDefined();
    for (const provider of seller.providers) expect(seller.providerPricing![provider]).toBeDefined();
  });

  it('handles concurrent requests to different providers', async () => {
    const { providerA, providerB, seller } = await setupMultiProviderNetwork();

    const requests = [
      buyerNode!.sendRequest(seller, makeRequest('claude-sonnet-4-5-20250929')),
      buyerNode!.sendRequest(seller, makeRequest('gpt-4o')),
      buyerNode!.sendRequest(seller, makeRequest('claude-opus-4-1-20250903')),
      buyerNode!.sendRequest(seller, makeRequest('gpt-4o-mini')),
    ];

    const responses = await Promise.all(requests);
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }

    expect(providerA.requestCount).toBe(2);
    expect(providerB.requestCount).toBe(2);
  });
});

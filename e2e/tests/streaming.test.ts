import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  PeerInfo,
} from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
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

/**
 * Mock provider that returns SSE (Server-Sent Events) responses.
 * Simulates a streaming Anthropic API response.
 */
class StreamingMockProvider implements Provider {
  readonly name = 'anthropic';
  readonly services = ['claude-sonnet-4-5-20250929'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 1,
      outputUsdPerMillion: 1,
    },
  };
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;

  /** The SSE events this provider will return. */
  readonly sseEvents: string[] = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","content":[],"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":100,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" from"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" streaming!"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    this.requestCount++;
    try {
      // Combine all SSE events into a single body
      const sseBody = this.sseEvents.join('');

      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
        },
        body: new TextEncoder().encode(sseBody),
      };
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

describe('Streaming: SSE streaming request flow across P2P boundary', () => {
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

  async function setupStreamingNetwork(): Promise<{
    streamingProvider: StreamingMockProvider;
    discoveredSeller: PeerInfo;
  }> {
    // 1. Bootstrap
    bootstrap = await createLocalBootstrap();

    // 2. Seller with streaming mock provider
    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
    const streamingProvider = new StreamingMockProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      natTraversal: false,
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(streamingProvider);
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

    return { streamingProvider, discoveredSeller: discoveredSeller! };
  }

  it('buyer receives SSE streaming response from seller', async () => {
    const { streamingProvider, discoveredSeller } = await setupStreamingNetwork();

    // Build a streaming request
    const requestBody = JSON.stringify({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 256,
      stream: true,
      messages: [{ role: 'user', content: 'Hello' }],
    });

    const request: SerializedHttpRequest = {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(requestBody),
    };

    // Send request and get response
    const response = await buyerNode!.sendRequest(discoveredSeller, request);

    // Assert: content-type is text/event-stream
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/event-stream');

    // Assert: response body contains all SSE events
    const responseText = new TextDecoder().decode(response.body);

    // Verify each expected SSE event type is present
    expect(responseText).toContain('event: message_start');
    expect(responseText).toContain('event: content_block_start');
    expect(responseText).toContain('event: content_block_delta');
    expect(responseText).toContain('event: content_block_stop');
    expect(responseText).toContain('event: message_delta');
    expect(responseText).toContain('event: message_stop');

    // Verify the streamed text content is present
    expect(responseText).toContain('"text":"Hello"');
    expect(responseText).toContain('"text":" from"');
    expect(responseText).toContain('"text":" streaming!"');

    // Verify provider was called
    expect(streamingProvider.requestCount).toBe(1);
  });
});

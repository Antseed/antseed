import { describe, it, expect, afterEach } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type { SerializedHttpRequest, SerializedHttpResponse, Provider } from '@antseed/node';
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

class DisconnectingProvider implements Provider {
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

  async handleRequest(_req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    try {
      throw new Error('Provider crashed mid-request');
    } finally {
      this._active--;
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency };
  }
}

describe('Negative: seller disconnects mid-request', () => {
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

  it('buyer receives an error when seller provider crashes', async () => {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-'));
    const crashProvider = new DisconnectingProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(crashProvider);
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

    await waitForPeers(buyerNode, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();

    const request: SerializedHttpRequest = {
      requestId: randomUUID(),
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 256,
        messages: [{ role: 'user', content: 'Hello' }],
      })),
    };

    const response = await buyerNode.sendRequest(seller!, request);
    expect(response.statusCode).toBeGreaterThanOrEqual(500);
  });
});

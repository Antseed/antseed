import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import OpenAI from 'openai';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AntseedNode } from '@antseed/node';
import type { PeerInfo } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockOpenAIImageProvider } from './helpers/mock-openai-provider.js';

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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Expected ${expectedCount} peer(s) within ${timeoutMs}ms`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to acquire free port')));
        return;
      }
      const { port } = address;
      server.close((err) => err ? reject(err) : resolve(port));
    });
  });
}

describe('OpenAI SDK integration: Images API over buyer proxy', () => {
  let tempHomeDir: string | null = null;
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;
  let proxy: { start(): Promise<void>; stop(): Promise<void> } | null = null;

  beforeAll(async () => {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'antseed-home-'));
    process.env['HOME'] = tempHomeDir;
    process.env['USERPROFILE'] = tempHomeDir;
  });

  afterEach(async () => {
    try { if (proxy) { await proxy.stop(); proxy = null; } } catch {}
    try { if (buyerNode) { await buyerNode.stop(); buyerNode = null; } } catch {}
    try { if (sellerNode) { await sellerNode.stop(); sellerNode = null; } } catch {}
    try { if (bootstrap) { await bootstrap.stop(); bootstrap = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
  });

  async function setupProxyNetwork(): Promise<{
    provider: MockOpenAIImageProvider;
    port: number;
    discoveredSeller: PeerInfo;
  }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-images-'));
    const provider = new MockOpenAIImageProvider();
    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
    });
    sellerNode.registerProvider(provider);
    await sellerNode.start();

    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-images-'));
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
    const discoveredSeller = peers.find((peer) => peer.peerId === sellerNode!.peerId);
    expect(discoveredSeller).toBeDefined();

    const port = await getFreePort();
    const { BuyerProxy } = await import('../../apps/cli/src/proxy/buyer-proxy.js');
    proxy = new BuyerProxy({
      node: buyerNode,
      port,
      dataDir: buyerDataDir!,
      backgroundRefreshIntervalMs: 60_000,
      peerCacheTtlMs: 1_000,
    });
    await proxy.start();

    return { provider, port, discoveredSeller: discoveredSeller! };
  }

  it('supports non-streaming images.generate through the proxy', async () => {
    const { provider, port, discoveredSeller } = await setupProxyNetwork();
    const client = new OpenAI({
      apiKey: 'sk-test',
      baseURL: `http://127.0.0.1:${port}/v1`,
      defaultHeaders: { 'x-antseed-pin-peer': discoveredSeller.peerId },
    });

    const response = await client.images.generate({
      model: 'gpt-image-2',
      prompt: 'A tiny purple cube',
      size: '1024x1024',
      quality: 'low',
    } as any);

    expect(response.created).toBeTypeOf('number');
    expect(response.data[0]?.b64_json).toBe(Buffer.from('mock-image-bytes').toString('base64'));
    expect(provider.requestCount).toBe(1);
    expect(provider.lastRequest?.path).toBe('/v1/images/generations');

    const upstreamBody = JSON.parse(new TextDecoder().decode(provider.lastRequest!.body)) as Record<string, unknown>;
    expect(upstreamBody.model).toBe('gpt-image-2');
    expect(upstreamBody.prompt).toBe('A tiny purple cube');
    expect(upstreamBody.size).toBe('1024x1024');
    expect(upstreamBody.quality).toBe('low');
  }, 30_000);
});

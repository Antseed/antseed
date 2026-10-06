import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { AntseedNode } from '@antseed/node';
import type { NodePaymentsConfig, PeerInfo, Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockOpenAIImageProvider } from './helpers/mock-openai-provider.js';

const execFileAsync = promisify(execFile);

// ─── Mock JSON-RPC server ────────────────────────────────────────────────────
// Responds to ethers JsonRpcProvider calls so ChannelsClient.reserve(),
// ChannelsClient.settle(), DepositsClient.getBuyerBalance(), etc. work
// without a real chain.

let rpcCallLog: Array<{ method: string; params: unknown[] }> = [];
let lastTxHash = '0x' + '11'.repeat(32);
let txCounter = 0;

async function handleSingleRpcRequest(parsed: { id: number; method: string; params?: unknown[] }): Promise<{ jsonrpc: string; id: number; result: unknown }> {
  rpcCallLog.push({ method: parsed.method, params: (parsed.params ?? []) as unknown[] });

  const makeResult = (result: unknown) => ({ jsonrpc: '2.0' as const, id: parsed.id, result });

  switch (parsed.method) {
    case 'eth_chainId':
      return makeResult('0x7a69');
    case 'net_version':
      return makeResult('31337');
    case 'eth_getTransactionCount':
      return makeResult('0x0');
    case 'eth_estimateGas':
      return makeResult('0x5208');
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return makeResult('0x3b9aca00');
    case 'eth_getBalance':
      return makeResult('0xde0b6b3a7640000');
    case 'eth_blockNumber':
      return makeResult('0x1');
    case 'eth_getBlockByNumber':
      return makeResult({
        number: '0x1',
        timestamp: '0x' + Math.floor(Date.now() / 1000).toString(16),
        baseFeePerGas: '0x3b9aca00',
        hash: '0x' + '33'.repeat(32),
        parentHash: '0x' + '00'.repeat(32),
        nonce: '0x0000000000000000',
        sha3Uncles: '0x' + '00'.repeat(32),
        logsBloom: '0x' + '00'.repeat(256),
        transactionsRoot: '0x' + '00'.repeat(32),
        stateRoot: '0x' + '00'.repeat(32),
        receiptsRoot: '0x' + '00'.repeat(32),
        miner: '0x' + '00'.repeat(20),
        difficulty: '0x0',
        totalDifficulty: '0x0',
        extraData: '0x',
        size: '0x100',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        transactions: [],
        uncles: [],
      });
    case 'eth_feeHistory':
      return makeResult({
        oldestBlock: '0x1',
        baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'],
        gasUsedRatio: [0.5],
        reward: [['0x3b9aca00']],
      });
    case 'eth_sendRawTransaction': {
      const rawTx = String((parsed.params ?? [])[0] ?? '0x');
      try {
        const { keccak256 } = await import('ethers');
        lastTxHash = keccak256(rawTx);
      } catch {
        txCounter++;
        lastTxHash = '0x' + txCounter.toString(16).padStart(64, '0');
      }
      return makeResult(lastTxHash);
    }
    case 'eth_getTransactionReceipt': {
      const requestedHash = String((parsed.params ?? [])[0] ?? lastTxHash);
      return makeResult({
        transactionHash: requestedHash,
        transactionIndex: '0x0',
        blockNumber: '0x1',
        blockHash: '0x' + '22'.repeat(32),
        from: '0x' + '00'.repeat(20),
        to: '0x' + 'cc'.repeat(20),
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        contractAddress: null,
        logs: [],
        logsBloom: '0x' + '00'.repeat(256),
        status: '0x1',
        effectiveGasPrice: '0x3b9aca00',
        type: '0x2',
      });
    }
    case 'eth_call': {
      const available = BigInt('10000000000');
      const reserved = 0n;
      const lastActivityAt = BigInt(Math.floor(Date.now() / 1000));
      const encode256 = (n: bigint) => n.toString(16).padStart(64, '0');
      return makeResult('0x' + encode256(available) + encode256(reserved) + encode256(lastActivityAt));
    }
    default:
      return makeResult('0x');
  }
}

function createMockRpcServer(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400);
          res.end('Bad request');
          return;
        }

        void (async () => {
          if (Array.isArray(parsed)) {
            const results = await Promise.all(
              parsed.map((entry: { id: number; method: string; params?: unknown[] }) =>
                handleSingleRpcRequest(entry),
              ),
            );
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(results));
          } else {
            const result = await handleSingleRpcRequest(parsed as { id: number; method: string; params?: unknown[] });
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(result));
          }
        })();
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr && typeof addr === 'object') {
        resolve({ server, url: `http://127.0.0.1:${addr.port}` });
      }
    });
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makePaymentsConfig(rpcUrl: string, overrides?: Partial<NodePaymentsConfig>): NodePaymentsConfig {
  return {
    enabled: true,
    rpcUrl,
    depositsAddress: '0x' + 'dd'.repeat(20),
    channelsAddress: '0x' + 'cc'.repeat(20),
    stakingAddress: '0x' + 'bb'.repeat(20),
    usdcAddress: '0x' + 'ee'.repeat(20),
    identityRegistryAddress: '0x' + 'aa'.repeat(20),
    chainId: 31337,
    minBudgetPerRequest: '10000',
    maxPerRequestUsdc: '100000',
    maxReserveAmountUsdc: '10000000',
    ...overrides,
  };
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Expected ${expectedCount} peer(s) within ${timeoutMs}ms`);
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OpenAI SDK integration: Images API payment flow over buyer proxy', () => {
  let tempHomeDir: string | null = null;
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;
  let proxy: { start(): Promise<void>; stop(): Promise<void> } | null = null;
  let rpcServer: Server | null = null;
  let rpcUrl = '';

  beforeAll(async () => {
    tempHomeDir = await mkdtemp(join(tmpdir(), 'antseed-home-'));
    process.env['HOME'] = tempHomeDir;
    process.env['USERPROFILE'] = tempHomeDir;
    await execFileAsync('pnpm', ['--filter', '@antseed/node', 'build'], {
      cwd: join(import.meta.dirname, '..', '..'),
    });
  });

  afterEach(async () => {
    try { if (proxy) { await proxy.stop(); proxy = null; } } catch {}
    try { if (buyerNode) { await buyerNode.stop(); buyerNode = null; } } catch {}
    try { if (sellerNode) { await sellerNode.stop(); sellerNode = null; } } catch {}
    try { if (bootstrap) { await bootstrap.stop(); bootstrap = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
    if (rpcServer) {
      await new Promise<void>((resolve) => rpcServer!.close(() => resolve()));
      rpcServer = null;
    }
    rpcUrl = '';
    rpcCallLog = [];
  });

  async function setupRpc(): Promise<void> {
    const rpc = await createMockRpcServer();
    rpcServer = rpc.server;
    rpcUrl = rpc.url;
    rpcCallLog = [];
  }

  async function setupProxyNetwork<P extends Provider = MockOpenAIImageProvider>(provider?: P): Promise<{
    provider: P;
    port: number;
    discoveredSeller: PeerInfo;
  }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-images-pay-'));
    const imageProvider = (provider ?? new MockOpenAIImageProvider()) as P;
    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl),
    });
    sellerNode.registerProvider(imageProvider);
    await sellerNode.start();

    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-images-pay-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl),
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

    return { provider: imageProvider, port, discoveredSeller: discoveredSeller! };
  }

  it('negotiates payment and records image usage for images.generate', async () => {
    await setupRpc();
    const { provider, port, discoveredSeller } = await setupProxyNetwork();

    const paymentEvents: string[] = [];
    buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

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
      n: 2,
    } as any);

    // The request should succeed through the buyer proxy and hit the image seller.
    expect(response.created).toBeTypeOf('number');
    expect(response.data?.[0]?.b64_json).toBe(Buffer.from('mock-image-bytes').toString('base64'));
    expect(response.data).toHaveLength(2);
    expect(provider.requestCount).toBe(1);
    expect(provider.lastRequest?.path).toBe('/v1/images/generations');

    // Discovery should carry the signed v12 billing model all the way into buyer peer info.
    expect(discoveredSeller.metadata?.version).toBe(12);
    const billingComponent = discoveredSeller
      .providerServiceUnitBillingModels?.openai?.services['gpt-image-2']?.['openai-images']?.components[0];
    expect(billingComponent).toMatchObject({
      unit: 'output_images',
      match: { size: '1024x1024' },
    });
    expect(billingComponent?.priceUsd).toBeCloseTo(0.04, 5);

    // The first paid request should negotiate automatically: 402 -> auth -> retry -> 200.
    expect(paymentEvents).toContain('required');
    expect(paymentEvents).toContain('signed');

    // Verify on-chain calls were attempted against the mocked RPC.
    const sendRawTxCalls = rpcCallLog.filter((call) => call.method === 'eth_sendRawTransaction');
    expect(sendRawTxCalls.length).toBeGreaterThanOrEqual(1);

    // Verify the buyer recorded the exact image unit-billing cost. Legacy token pricing
    // and response token usage are both zero, so this fails if billing silently
    // falls back to token pricing or treats the image service as free.
    const bpm = buyerNode!.buyerPaymentManager;
    expect(bpm).not.toBeNull();
    expect(bpm!.getActiveSession(discoveredSeller.peerId)).not.toBeNull();
    expect(bpm!.getVerifiedCost(discoveredSeller.peerId)).toBe(80_000n);
    // Prompt estimate as input; 2 images x 1290-token equivalent as output.
    expect(bpm!.getCumulativeTokens(discoveredSeller.peerId)).toEqual({
      inputTokens: 4n,
      outputTokens: 2_580n,
    });
    expect(bpm!.getResponseTokenTotals(discoveredSeller.peerId)).toEqual({
      input: 0,
      output: 0,
      requests: 1,
    });
    expect(bpm!.getCumulativeAmount(discoveredSeller.peerId)).toBe(80_000n);
  }, 30_000);

  it('treats image services without explicit unit billing as free', async () => {
    await setupRpc();
    const { provider, port, discoveredSeller } = await setupProxyNetwork(
      new MockOpenAIImageProvider({ serviceUnitBillingModels: null }),
    );

    const paymentEvents: string[] = [];
    buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

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
      n: 2,
    } as any);

    expect(response.data).toHaveLength(2);
    expect(provider.requestCount).toBe(1);
    expect(discoveredSeller.providerServiceUnitBillingModels).toBeUndefined();
    expect(paymentEvents).toEqual([]);
    expect(rpcCallLog.some((call) => call.method === 'eth_sendRawTransaction')).toBe(false);
    expect(buyerNode!.buyerPaymentManager?.getActiveSession(discoveredSeller.peerId)).toBeNull();
    expect(buyerNode!.buyerPaymentManager?.getVerifiedCost(discoveredSeller.peerId)).toBe(0n);
  }, 30_000);

  it('bills a model-routing rank as one completed request through the same payment flow', async () => {
    await setupRpc();
    let rankCalls = 0;
    const routing: Provider = {
      name: 'alpha',
      services: ['alpha-route'],
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { 'alpha-route': ['model-routing'] },
      serviceUnitBillingModels: { 'alpha-route': { 'model-routing': {
        version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }],
      } } },
      maxConcurrency: 5,
      getCapacity: () => ({ current: 0, max: 5 }),
      async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
        rankCalls++;
        const { routing: { candidates }, request } = JSON.parse(Buffer.from(req.body).toString());
        if (request.messages[0].content === 'bad') {
          return { requestId: req.requestId, statusCode: 200, headers: {}, body: Buffer.from('not a ranking') };
        }
        return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
          body: Buffer.from(JSON.stringify({ id: 'rank-1', object: 'routing.ranking', created: 1, router: { id: 'alpha', version: '1' },
            ranked: [{ candidate_id: candidates[0].id }] })) };
      },
    };
    const { discoveredSeller } = await setupProxyNetwork(routing);

    const rank = (text = 'hi') => buyerNode!.sendRequest(discoveredSeller, {
      requestId: crypto.randomUUID(), method: 'POST', path: '/v1/routing/rank',
      headers: { 'content-type': 'application/json', 'x-antseed-provider': 'alpha', 'x-antseed-service': 'alpha-route' },
      body: Buffer.from(JSON.stringify({ request: { messages: [{ role: 'user', content: text }] },
        routing: { candidates: [{ id: 'm@b', model: 'm', pricing: { input: 1, cache_read: 1, output: 1 } }] } })),
    });

    // First call negotiates (402 -> reserve -> retry). A malformed answer costs nothing on
    // either side, so it cannot leave the seller waiting for a payment that never comes.
    expect((await rank()).statusCode).toBe(200);
    expect((await rank('bad')).statusCode).toBe(200);
    expect((await rank()).statusCode).toBe(200);
    expect(rankCalls).toBe(3);
    const bpm = buyerNode!.buyerPaymentManager!;
    await vi.waitFor(() => expect(bpm.getCumulativeAmount(discoveredSeller.peerId)).toBe(2_000n));
    expect(bpm.getVerifiedCost(discoveredSeller.peerId)).toBe(2_000n);
  }, 30_000);
});

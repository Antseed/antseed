import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import OpenAI from 'openai';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { AntseedNode } from '@antseed/node';
import { ANTSEED_UPLOAD_THRESHOLD_BYTES } from '../../packages/protocol/src/http.js';
import type { NodePaymentsConfig, PeerInfo, Provider } from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { MockOpenAIImageProvider } from './helpers/mock-openai-provider.js';
import venicePlugin from '../../plugins/provider-venice/src/index.js';
import seedancePlugin from '../../plugins/provider-seedance/src/index.js';
import { runLiveVeniceMatrix } from './helpers/live-venice-matrix.js';

const execFileAsync = promisify(execFile);
const liveVeniceKey = process.env['ANTSEED_LIVE_VENICE_KEY'];
delete process.env['ANTSEED_LIVE_VENICE_KEY'];

function largeVideoInputImage(): string {
  const chunk = (type: string, data: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc32(contents));
    return Buffer.concat([length, contents, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(512, 0);
  header.writeUInt32BE(512, 4);
  header[8] = 8;
  header[9] = 2;
  const pixels = randomBytes(512 * (512 * 3 + 1));
  for (let row = 0; row < 512; row += 1) pixels[row * (512 * 3 + 1)] = 0;
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0)),
  ]).toString('base64');
}

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
    await execFileAsync('pnpm', ['--filter', '@antseed/node', 'build'], {
      cwd: join(import.meta.dirname, '..', '..'),
    });
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

  async function setupProxyNetwork<ProviderType extends Provider = MockOpenAIImageProvider>(provider?: ProviderType, resumeState?: string): Promise<{
    provider: ProviderType;
    port: number;
    discoveredSeller: PeerInfo;
  }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-images-pay-'));
    if (resumeState) await cp(join(resumeState, 'seller'), sellerDataDir, { recursive: true });
    const imageProvider = provider ?? new MockOpenAIImageProvider() as unknown as ProviderType;
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
    if (resumeState) await cp(join(resumeState, 'buyer'), buyerDataDir, { recursive: true });
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

  it.skipIf(process.env['ANTSEED_LIVE_VENICE'] !== '1')('generates a real Venice video matrix through buyer and seller', async () => {
    if (!liveVeniceKey) throw new Error('ANTSEED_LIVE_VENICE_KEY is required');
    await setupRpc();
    await runLiveVeniceMatrix(liveVeniceKey, async (provider) => {
      const network = await setupProxyNetwork(provider, process.env['ANTSEED_LIVE_VENICE_RESUME_STATE']);
      return { ...network, buyer: buyerNode! };
    });
  }, 25 * 60_000);

  it.each([
    ['tcp-encrypted', true, 'text'], ['webrtc', true, 'image'], ['tcp-encrypted', false, 'image'], ['webrtc', false, 'text'],
  ] as const)('runs a Venice queue, streamed retrieve and complete over %s with content length %s and %s input and one charge', async (transport, hasContentLength, inputKind) => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const origin = 'https://api.venice.ai';
    const video = Buffer.alloc(3 * 1024 * 1024 + 17, 9);
    const calls: Array<{ path: string; body: any }> = [];
    const createBody = JSON.stringify({ model: 'wan-2.5', prompt: 'boat', duration: '5s', ...(inputKind === 'image' ? { image_url: `data:image/png;base64,${largeVideoInputImage()}` } : {}) });
    if (inputKind === 'image') expect(Buffer.byteLength(createBody)).toBeGreaterThan(ANTSEED_UPLOAD_THRESHOLD_BYTES);
    let ready = false;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${origin}/`)) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer seller-secret');
      const path = new URL(url).pathname;
      const body = JSON.parse(Buffer.from(init!.body as Uint8Array).toString());
      calls.push({ path, body });
      if (path === '/api/v1/video/queue') {
        expect(Buffer.from(init!.body as Uint8Array).toString()).toBe(createBody);
        return Response.json({ model: body.model, queue_id: 'queue-1' });
      }
      if (!ready) return Response.json({ status: 'PROCESSING', average_execution_time: 1000, execution_duration: 10 });
      return new Response(video, { headers: { 'content-type': 'video/mp4', ...(hasContentLength ? { 'content-length': String(video.length) } : {}) } });
    });
    try {
      const provider = await venicePlugin.createProvider({ VENICE_API_KEY: 'seller-secret', ANTSEED_ALLOWED_SERVICES: 'wan-2.5', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"wan-2.5":{"venice-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.01}]}}}' });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const manager = (buyerNode as any)._connectionManager;
      if (transport === 'webrtc') {
        const createConnection = manager.createConnection.bind(manager);
        manager.createConnection = (config: any) => createConnection({ ...config, remoteCapabilities: config.remoteCapabilities.filter((capability: string) => capability !== 'transport.tcp-enc.v1') });
      }
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: object) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const created = await fetch(`${base}/api/v1/video/queue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-idempotency-key': 'venice-input' }, body: createBody });
      expect(created.status).toBe(200);
      expect((await created.json()).queue_id).toBe('queue-1');
      const replay = await fetch(`${base}/api/v1/video/queue`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-idempotency-key': 'venice-input' }, body: createBody });
      expect(replay.status).toBe(200);
      expect((await replay.json()).queue_id).toBe('queue-1');
      expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(50_000n);
      const pending = await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'queue-1' });
      expect(pending.status).toBe(200);
      expect((await pending.json()).status).toBe('PROCESSING');
      ready = true;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const download = await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'queue-1' });
        expect(download.status).toBe(200);
        expect(download.headers.get('content-type')).toBe('video/mp4');
        expect(Buffer.from(await download.arrayBuffer())).toEqual(video);
      }
      expect((await post('/api/v1/video/complete', { model: 'wan-2.5', queue_id: 'queue-1' })).status).toBe(404);
      expect((await post('/api/v1/video/retrieve', { model: 'wan-2.5', queue_id: 'unknown' })).status).toBe(404);
      expect((await post('/api/v1/video/retrieve', { model: 'wan-2.5' })).status).toBe(404);
      const callsBefore = calls.length;
      (sellerNode as any)._resourceOwnership.recordAcceptedCreate('venice-video', 'someone-elses', '11'.repeat(20));
      const denied = await buyerNode!.sendRequest(discoveredSeller, { requestId: 'non-owner', method: 'POST', path: '/api/v1/video/retrieve', headers: { 'content-type': 'application/json', 'x-antseed-service': 'wan-2.5', 'x-antseed-provider': 'venice', 'x-antseed-video-download': 'video-stream-v1' }, body: Buffer.from('{"queue_id":"someone-elses"}') }, { pinned: true });
      expect(denied.statusCode).toBe(404);
      expect(calls.length).toBe(callsBefore);
      expect(calls.filter(call => call.path === '/api/v1/video/queue')).toHaveLength(1);
      expect(manager.getConnection(discoveredSeller.peerId).transportDescription).toBe(transport);
      expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(50_000n);
      await vi.waitFor(() => {
        const auths = (buyerNode as any)._verificationStorage.listResponseAuthsBySeller(discoveredSeller.peerId);
        expect(auths.filter((auth: any) => !auth.verified).map((auth: any) => auth.verificationError)).toEqual([]);
      });
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);

  it('runs Seedance draft and final tasks on the draft seller with per-task billing', async () => {
    await setupRpc();
    const originalFetch = globalThis.fetch;
    const origin = 'https://ark.ap-southeast.bytepluses.com';
    const calls: Array<{ method: string; path: string; body?: any }> = [];
    let next = 0;
    vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (!url.startsWith(`${origin}/`)) {
        const headers = new Headers(init?.headers);
        headers.set('connection', 'close');
        return originalFetch(input, { ...init, headers });
      }
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ark-secret');
      const path = new URL(url).pathname;
      const method = init?.method ?? 'GET';
      const raw = init?.body ? Buffer.from(init.body as Uint8Array).toString() : '';
      calls.push({ method, path, ...(raw ? { body: JSON.parse(raw) } : {}) });
      if (method === 'POST') return Response.json({ id: `cgt-${++next}` });
      return Response.json({ id: path.split('/').at(-1), status: 'succeeded', content: { video_url: 'https://seller-tos.example/video.mp4' }, usage: { completion_tokens: 1 } });
    });
    try {
      const provider = await seedancePlugin.createProvider({ ARK_API_KEY: 'ark-secret', ANTSEED_ALLOWED_SERVICES: 'seedance-2-5', ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: '{"seedance-2-5":{"seedance-video":{"version":1,"components":[{"unit":"video_seconds","priceUsd":0.01}]}}}' });
      const { port, discoveredSeller } = await setupProxyNetwork(provider);
      const base = `http://127.0.0.1:${port}`;
      const post = (body: object) => fetch(`${base}/api/v3/contents/generations/tasks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'seedance-2-5', ...body }) });
      const draft = await post({ content: [{ type: 'text', text: 'boat' }], draft: true, resolution: '480p', duration: 4 });
      expect(draft.status).toBe(200);
      expect((await draft.json()).id).toBe('cgt-1');
      expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(40_000n);
      const final = await post({ content: [{ type: 'draft_task', draft_task: { id: 'cgt-1' } }], duration: 5 });
      expect(final.status).toBe(200);
      expect((await final.json()).id).toBe('cgt-2');
      expect(calls[1]!.body.content[0]).toEqual({ type: 'draft_task', draft_task: { id: 'cgt-1' } });
      expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(90_000n);
      const status = await fetch(`${base}/api/v3/contents/generations/tasks/cgt-2`);
      expect((await status.json()).content.video_url).toBe('https://seller-tos.example/video.mp4');
      expect((await fetch(`${base}/api/v3/contents/generations/tasks/cgt-2`, { method: 'DELETE' })).status).toBe(404);
      expect((await post({ content: [{ type: 'draft_task', draft_task: { id: 'cgt-unknown' } }], duration: 5 })).status).toBe(404);
      expect((await fetch(`${base}/api/v3/contents/generations/tasks?page_size=500`)).status).toBe(404);
      const callsBefore = calls.length;
      (sellerNode as any)._resourceOwnership.recordAcceptedCreate('seedance-video', 'cgt-foreign', '11'.repeat(20));
      const stolen = await buyerNode!.sendRequest(discoveredSeller, { requestId: 'foreign-draft', method: 'POST', path: '/api/v3/contents/generations/tasks', headers: { 'content-type': 'application/json', 'x-antseed-provider': 'seedance' }, body: Buffer.from(JSON.stringify({ model: 'seedance-2-5', duration: 5, content: [{ type: 'draft_task', draft_task: { id: 'cgt-foreign' } }] })) }, { pinned: true });
      expect(stolen.statusCode).toBe(404);
      expect(calls.length).toBe(callsBefore);
      expect(calls.map(call => `${call.method} ${call.path}`)).toEqual([
        'POST /api/v3/contents/generations/tasks', 'POST /api/v3/contents/generations/tasks',
        'GET /api/v3/contents/generations/tasks/cgt-2', 'DELETE /api/v3/contents/generations/tasks/cgt-2',
      ]);
      expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(90_000n);
    } finally { vi.unstubAllGlobals(); }
  }, 60_000);

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

  for (const name of ['seedance'] as const) {
    it.each(['text', 'image'] as const)(`relays seller-operated ${name} %s-to-video jobs with acceptance billing and free follow-ups`, async (inputKind) => {
      await setupRpc();
      const protocol = 'seedance-video';
      const owners = new Map<string, string>();
      let submissions = 0;
      let lastSubmission: unknown;
      let lastSubmissionBytes: Buffer | undefined;
      const sellerApi = createServer(async (request, response) => {
        if (request.url === '/result') {
          response.writeHead(200, { 'content-type': 'video/mp4' });
          response.end('mock-video');
          return;
        }
        const buyer = String(request.headers['x-antseed-buyer-peer-id'] ?? '');
        const credentials = name === 'seedance' ? request.headers.authorization : request.headers['x-goog-api-key'];
        if (credentials !== (name === 'seedance' ? 'Bearer endpoint-secret' : 'endpoint-secret') || !buyer) {
          response.writeHead(401); response.end(); return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        if (request.method === 'POST') {
          submissions += 1;
          lastSubmissionBytes = Buffer.concat(chunks);
          lastSubmission = JSON.parse(lastSubmissionBytes.toString());
          owners.set('job', buyer);
        }
        if (owners.get('job') !== buyer) { response.writeHead(403); response.end(); return; }
        const address = sellerApi.address() as { port: number };
        const uri = `http://127.0.0.1:${address.port}/result`;
        const body = { id: 'job', ...(request.method === 'POST' ? {} : { status: 'succeeded', content: { video_url: uri } }) };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      });
      await new Promise<void>(resolve => sellerApi.listen(0, '127.0.0.1', resolve));
      try {
        const address = sellerApi.address() as { port: number };
        const provider = await seedancePlugin.createProvider({
          ARK_BASE_URL: `http://127.0.0.1:${address.port}`, ARK_API_KEY: 'endpoint-secret',
          ANTSEED_ALLOWED_SERVICES: 'video-model',
          ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON: JSON.stringify({ 'video-model': { [protocol]: { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.01 }] } } }),
        });
        const { port, discoveredSeller } = await setupProxyNetwork(provider);
        const manager = (buyerNode as any)._connectionManager;
        if (inputKind === 'image') {
          const createConnection = manager.createConnection.bind(manager);
          manager.createConnection = (config: any) => createConnection({ ...config, remoteCapabilities: config.remoteCapabilities.filter((capability: string) => capability !== 'transport.tcp-enc.v1') });
        }
        const image = inputKind === 'image' ? largeVideoInputImage() : undefined;
        const body = { model: 'video-model', service: 'extension', content: [{ type: 'text', text: '猫' }, ...(image ? [{ type: 'image_url', image_url: { url: `data:image/png;base64,${image}` }, role: 'first_frame' }] : [])], duration: 8, custom: { enabled: true } };
        const path = '/api/v3/contents/generations/tasks';
        const rawBody = ` \n${JSON.stringify(body, null, 2)}\n`;
        if (image) expect(Buffer.byteLength(rawBody)).toBeGreaterThan(ANTSEED_UPLOAD_THRESHOLD_BYTES);
        const createOptions = { method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-idempotency-key': `${name}-${inputKind}` }, body: rawBody };
        const created = await fetch(`http://127.0.0.1:${port}${path}`, createOptions);
        expect(created.status).toBe(200);
        expect(await created.json()).toEqual({ id: 'job' });
        const replay = await fetch(`http://127.0.0.1:${port}${path}`, createOptions);
        expect(replay.status).toBe(200);
        expect(await replay.json()).toEqual({ id: 'job' });
        expect(lastSubmission).toEqual(body);
        expect(lastSubmissionBytes).toEqual(Buffer.from(rawBody));
        expect(submissions).toBe(1);
        if (image) expect(manager.getConnection(discoveredSeller.peerId).transportDescription).toBe('webrtc');
        expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(80_000n);
        const statusPath = '/api/v3/contents/generations/tasks/job';
        for (let poll = 0; poll < 2; poll += 1) {
          const status = await fetch(`http://127.0.0.1:${port}${statusPath}`);
          expect(status.status).toBe(200);
          const result = await status.json() as any;
          const uri = result.content.video_url;
          expect(await (await fetch(uri)).text()).toBe('mock-video');
        }
        expect(buyerNode!.buyerPaymentManager!.getVerifiedCost(discoveredSeller.peerId)).toBe(80_000n);
        expect(submissions).toBe(1);
      } finally {
        await new Promise<void>((resolve, reject) => sellerApi.close(error => error ? reject(error) : resolve()));
      }
    }, 30_000);
  }
});

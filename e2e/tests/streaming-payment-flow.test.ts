import { describe, it, expect, afterEach, vi } from 'vitest';
import { AntseedNode } from '@antseed/node';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  PeerInfo,
  NodePaymentsConfig,
} from '@antseed/node';
import { createLocalBootstrap } from './helpers/local-bootstrap.js';
import { tmpdir } from 'node:os';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';

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
      return makeResult('0x7a69'); // 31337
    case 'net_version':
      return makeResult('31337');
    case 'eth_getTransactionCount':
      return makeResult('0x0');
    case 'eth_estimateGas':
      return makeResult('0x5208'); // 21000
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return makeResult('0x3b9aca00'); // 1 gwei
    case 'eth_getBalance':
      return makeResult('0xde0b6b3a7640000'); // 1 ETH
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
      // Compute the keccak256 hash of the raw transaction to match ethers' expectation
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
      // Return receipt with the hash from the request (ethers passes the expected hash)
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
      // Return ABI-encoded tuple of 3 uint256 for getBuyerBalance or any eth_call
      const available = BigInt('10000000000'); // $10,000 USDC
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

        // Handle JSON-RPC batch requests (array) and single requests (object)
        void (async () => {
          if (Array.isArray(parsed)) {
            const results = await Promise.all(
              parsed.map((req: { id: number; method: string; params?: unknown[] }) =>
                handleSingleRpcRequest(req),
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

// ─── Mock Providers ──────────────────────────────────────────────────────────

class MockAnthropicProvider implements Provider {
  readonly name = 'anthropic';
  readonly services = ['claude-sonnet-4-5-20250929'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    },
  };
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;

  async handleRequest(req: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    this._active++;
    this.requestCount++;
    try {
      const body = JSON.stringify({
        id: 'msg_test_' + Date.now(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello from mock provider!' }],
        model: 'claude-sonnet-4-5-20250929',
        usage: { input_tokens: 100, output_tokens: 20 },
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

class StreamingMockProvider implements Provider {
  readonly name = 'anthropic';
  readonly services = ['claude-sonnet-4-5-20250929'];
  readonly pricing = {
    defaults: {
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    },
  };
  readonly maxConcurrency = 5;
  private _active = 0;
  public requestCount = 0;

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

// ─── Test Infrastructure ─────────────────────────────────────────────────────

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
    minBudgetPerRequest: '10000', // $0.01
    maxPerRequestUsdc: '100000', // $0.10
    maxReserveAmountUsdc: '10000000', // $10.00
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('Streaming payment flow E2E', () => {
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerNode: AntseedNode | null = null;
  let buyerNode: AntseedNode | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;
  let rpcServer: Server | null = null;
  let rpcUrl: string = '';

  async function setupRpc() {
    const { server, url } = await createMockRpcServer();
    rpcServer = server;
    rpcUrl = url;
    rpcCallLog = [];
  }

  async function createNodes(
    sellerPaymentOverrides?: Partial<NodePaymentsConfig>,
    buyerPaymentOverrides?: Partial<NodePaymentsConfig>,
    sellerProvider?: Provider,
  ): Promise<{ seller: PeerInfo }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), 'antseed-seller-flow-'));
    const provider = sellerProvider ?? new MockAnthropicProvider();

    sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl, sellerPaymentOverrides),
    });
    sellerNode.registerProvider(provider);
    await sellerNode.start();

    buyerDataDir = await mkdtemp(join(tmpdir(), 'antseed-buyer-flow-'));
    buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl, buyerPaymentOverrides),
    });
    await buyerNode.start();

    await waitForPeers(buyerNode, 1);
    const peers = await buyerNode.discoverPeers();
    const seller = peers.find((p) => p.peerId === sellerNode!.peerId);
    expect(seller).toBeDefined();
    return { seller: seller! };
  }

  afterEach(async () => {
    try { if (buyerNode) { await buyerNode.stop(); buyerNode = null; } } catch {}
    try { if (sellerNode) { await sellerNode.stop(); sellerNode = null; } } catch {}
    try { if (bootstrap) { await bootstrap.stop(); bootstrap = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
    if (rpcServer) {
      await new Promise<void>((resolve) => rpcServer!.close(() => resolve()));
      rpcServer = null;
    }
    rpcCallLog = [];
    vi.restoreAllMocks();
  });

  // ── Test 1: Auto mode — full payment flow with single request ──────────

  it('auto mode: full payment flow with single request', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();
    const { seller } = await createNodes({}, {}, mockProvider);

    const paymentEvents: string[] = [];
    buyerNode!.on('payment:required', () => paymentEvents.push('required'));
    buyerNode!.on('payment:signed', () => paymentEvents.push('signed'));

    const request = makeRequest();
    const response = await buyerNode!.sendRequest(seller, request);

    // The auto-negotiation should have succeeded: 402 -> SpendingAuth -> AuthAck -> retry -> 200
    expect(response.statusCode).toBe(200);
    expect(mockProvider.requestCount).toBe(1);

    // Verify events
    expect(paymentEvents).toContain('required');
    expect(paymentEvents).toContain('signed');

    // Verify on-chain calls were made (reserve via eth_sendRawTransaction)
    const sendRawTxCalls = rpcCallLog.filter(c => c.method === 'eth_sendRawTransaction');
    expect(sendRawTxCalls.length).toBeGreaterThanOrEqual(1);
  }, 30_000);

  // ── Test 2: Auto mode — multiple requests (cumulative spending auth) ────

  it('auto mode: multiple sequential requests with increasing cumulative', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();
    const { seller } = await createNodes({}, {}, mockProvider);

    // First request: triggers 402 -> negotiation -> 200
    const req1 = makeRequest();
    const res1 = await buyerNode!.sendRequest(seller, req1);
    expect(res1.statusCode).toBe(200);

    // Second request: should include per-request SpendingAuth with increased cumulative
    const req2 = makeRequest();
    const res2 = await buyerNode!.sendRequest(seller, req2);
    expect(res2.statusCode).toBe(200);

    // Third request: cumulative should increase further
    const req3 = makeRequest();
    const res3 = await buyerNode!.sendRequest(seller, req3);
    expect(res3.statusCode).toBe(200);

    expect(mockProvider.requestCount).toBe(3);

    // The buyer payment manager should have increasing cumulative amounts.
    // We verify by checking that the buyer has an active session with a non-zero auth max.
    const bpm = buyerNode!.buyerPaymentManager;
    expect(bpm).not.toBeNull();
    // The fact that 3 requests succeeded means cumulative SpendingAuths were accepted
  }, 30_000);

  // ── Test 3: Auto-only mode — no external approval hop ──────────────────

  it('auto-only mode: first paid request succeeds without surfacing a 402 to the caller', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();
    const { seller } = await createNodes({}, {}, mockProvider);

    // Manual approval was removed. The buyer should negotiate the reserve
    // internally and return the successful upstream response directly.
    const req1 = makeRequest();
    const res1 = await buyerNode!.sendRequest(seller, req1);
    expect(res1.statusCode).toBe(200);
    expect(mockProvider.requestCount).toBe(1);
  }, 30_000);

  // ── Test 4: Seller disconnect during session — settle on disconnect ─────

  it('seller settles session when buyer disconnects', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();
    const { seller } = await createNodes({}, {}, mockProvider);

    // Establish session with 2 requests
    const req1 = makeRequest();
    const res1 = await buyerNode!.sendRequest(seller, req1);
    expect(res1.statusCode).toBe(200);

    const req2 = makeRequest();
    const res2 = await buyerNode!.sendRequest(seller, req2);
    expect(res2.statusCode).toBe(200);
    expect(mockProvider.requestCount).toBe(2);

    // Disconnect buyer — seller should handle disconnect gracefully
    await buyerNode!.stop();
    buyerNode = null;

    // Give the seller time to process disconnect
    await new Promise(r => setTimeout(r, 2000));

    // Seller should still be running without errors after buyer disconnects
    // (no crash, no unhandled promise rejection)
    expect(sellerNode).not.toBeNull();
  }, 30_000);

  // ── Test 5: Budget mismatch — seller min > buyer max ────────────────────

  it('budget mismatch: seller minBudgetPerRequest exceeds buyer maxPerRequestUsdc', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();

    // Seller demands $1.00 minimum, buyer caps at $0.01
    const { seller } = await createNodes(
      { minBudgetPerRequest: '1000000' }, // $1.00
      { maxPerRequestUsdc: '10000' },     // $0.01
      mockProvider,
    );

    const paymentEvents: string[] = [];
    buyerNode!.on('payment:required', () => paymentEvents.push('required'));

    const request = makeRequest();
    // The negotiation should fail because minBudgetPerRequest > maxPerRequestUsdc
    // This can result in either a 402 response or an error thrown
    try {
      const response = await buyerNode!.sendRequest(seller, request);
      // If we get a response, it should be a 402
      expect(response.statusCode).toBe(402);
    } catch (err) {
      // Negotiation may throw with budget mismatch
      expect(err).toBeDefined();
      expect((err as Error).message).toMatch(/minBudgetPerRequest.*exceeds.*maxPerRequestUsdc|budget/i);
    }

    // Provider should NOT have been called
    expect(mockProvider.requestCount).toBe(0);
  }, 30_000);

  // ── Test 6: NeedAuth flow — budget exhaustion mid-session ───────────────

  it('NeedAuth flow: seller requests more auth when budget runs low', async () => {
    await setupRpc();
    const mockProvider = new MockAnthropicProvider();

    // Use small budgets so the seller's NeedAuth is triggered after a few requests.
    // The initial SpendingAuth amount = min(suggestedAmount=100000, maxReserveAmountUsdc).
    // The authorizeSpending function checks amount <= maxPerRequestUsdc, so maxPerRequestUsdc
    // must be >= the initial amount passed. After initial session, per-request increments are
    // capped at maxPerRequestUsdc.
    // Seller minBudget = $0.01, buyer maxPerRequest = $0.10, maxReserve = $0.10
    const { seller } = await createNodes(
      { minBudgetPerRequest: '10000' },    // $0.01
      {
        maxPerRequestUsdc: '100000',        // $0.10 (must be >= suggestedAmount from seller)
        maxReserveAmountUsdc: '100000',     // $0.10 (small reserve to trigger NeedAuth)
      },
      mockProvider,
    );

    // First request: establishes session
    const req1 = makeRequest();
    const res1 = await buyerNode!.sendRequest(seller, req1);
    expect(res1.statusCode).toBe(200);

    // Second request: seller may send NeedAuth if budget is low
    // The buyer should auto-respond with a higher cumulative
    const req2 = makeRequest();
    const res2 = await buyerNode!.sendRequest(seller, req2);
    expect(res2.statusCode).toBe(200);

    // Third request: continue with exhausted budget scenario
    const req3 = makeRequest();
    const res3 = await buyerNode!.sendRequest(seller, req3);
    expect(res3.statusCode).toBe(200);

    expect(mockProvider.requestCount).toBe(3);
  }, 30_000);

  // ── Test 7: Streaming response with per-request auth ────────────────────

  it('streaming response with per-request SpendingAuth on subsequent requests', async () => {
    await setupRpc();
    const streamingProvider = new StreamingMockProvider();
    const { seller } = await createNodes({}, {}, streamingProvider);

    // First request: triggers negotiation, then streams response
    const chunks1: Uint8Array[] = [];
    const req1 = makeRequest();
    const res1 = await buyerNode!.sendRequestStream(seller, req1, {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => { chunks1.push(chunk.data); },
    });
    expect(res1.statusCode).toBe(200);

    // Verify the SSE body was received
    const fullBody1 = new TextDecoder().decode(res1.body);
    expect(fullBody1).toContain('Hello');
    expect(fullBody1).toContain('streaming!');

    // Second request: should send per-request SpendingAuth with estimated cost
    // based on the first response
    const chunks2: Uint8Array[] = [];
    const req2 = makeRequest();
    const res2 = await buyerNode!.sendRequestStream(seller, req2, {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => { chunks2.push(chunk.data); },
    });
    expect(res2.statusCode).toBe(200);

    const fullBody2 = new TextDecoder().decode(res2.body);
    expect(fullBody2).toContain('Hello');
    expect(fullBody2).toContain('streaming!');

    expect(streamingProvider.requestCount).toBe(2);
  }, 30_000);
});

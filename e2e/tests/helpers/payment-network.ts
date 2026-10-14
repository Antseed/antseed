import { afterEach, beforeAll, expect } from 'vitest';
import { createServer as createNetServer } from 'node:net';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { Interface } from 'ethers';
import { AntseedNode } from '@antseed/node';
import type { NodePaymentsConfig, PeerInfo, Provider } from '@antseed/node';
import { createLocalBootstrap } from './local-bootstrap.js';
import { MockOpenAIImageProvider } from './mock-openai-provider.js';

const execFileAsync = promisify(execFile);

const mockPaymentViewInterface = new Interface([
  'function channels(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'function channelsAddress() external view returns (address)',
  'function getBuyerBalance(address buyer) external view returns (uint256 available, uint256 reserved, uint256 lastActivityAt)',
  'function getBuyerCreditLimit(address buyer) external view returns (uint256)',
  'function uniqueSellersCharged(address buyer) external view returns (uint256)',
  'function getOperator(address buyer) external view returns (address)',
  'function getOperatorNonce(address buyer) external view returns (uint256)',
  'function domainSeparator() external view returns (bytes32)',
  'function FIRST_SIGN_CAP() external view returns (uint256)',
  'function TOP_UP_SETTLED_THRESHOLD_BPS() external view returns (uint256)',
  'function getAgentStats(uint256 agentId) external view returns (uint64 channelCount, uint64 ghostCount, uint256 totalVolumeUsdc, uint64 lastSettledAt)',
  'function balanceOf(address owner) external view returns (uint256)',
]);

// ─── Mock JSON-RPC server ────────────────────────────────────────────────────
// Responds to ethers JsonRpcProvider calls so ChannelsClient.reserve(),
// ChannelsClient.settle(), DepositsClient.getBuyerBalance(), etc. work
// without a real chain.

let rpcCallLog: Array<{ method: string; params: unknown[] }> = [];
let lastTxHash = '0x' + '11'.repeat(32);
let txCounter = 0;
let mockChannelActive = false;

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
      mockChannelActive = true;
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
      const call = (parsed.params ?? [])[0] as { data?: unknown } | undefined;
      const selector = typeof call?.data === 'string' ? call.data.slice(0, 10).toLowerCase() : '';
      const selectorFor = (name: string) => mockPaymentViewInterface.getFunction(name)!.selector;

      if (selector === selectorFor('channels')) {
        // Before reserve(), report a missing channel. After the mock seller
        // sends its transaction, expose an active channel with test credit so
        // video headroom checks can follow the real payment path.
        const channelWords = [
          0n, 0n, mockChannelActive ? available : 0n, 0n, 0n,
          0n, 0n, 0n, mockChannelActive ? 1n : 0n,
        ];
        return makeResult('0x' + channelWords.map(encode256).join(''));
      }
      if (selector === selectorFor('getBuyerBalance')) {
        return makeResult('0x' + encode256(available) + encode256(reserved) + encode256(lastActivityAt));
      }
      if (selector === selectorFor('getAgentStats')) {
        return makeResult('0x' + encode256(0n).repeat(4));
      }
      if (selector === selectorFor('TOP_UP_SETTLED_THRESHOLD_BPS')) {
        // Basis points, so it must be a real value: the buyer refuses to check a plan without it.
        return makeResult('0x' + encode256(8_500n));
      }
      if (selector === selectorFor('channelsAddress')) {
        // The configured mock address is a plain channels contract, not a facade.
        return makeResult('0x');
      }
      // Scalar view functions (domainSeparator, credit limits, ERC-20 balances,
      // and payment constants) only need one ABI word in this mock chain.
      return makeResult('0x' + encode256(available));
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

// ─── Seller, buyer and buyer proxy on a mock chain ───────────────────────────

/**
 * Registers hooks that build the @antseed/node package, isolate HOME and tear
 * everything down after each test. Call it inside a describe block.
 */
export function usePaymentNetwork(label: string) {
  let tempHomeDir: string | null = null;
  let bootstrap: Awaited<ReturnType<typeof createLocalBootstrap>> | null = null;
  let sellerDataDir: string | null = null;
  let buyerDataDir: string | null = null;
  let proxy: { start(): Promise<void>; stop(): Promise<void> } | null = null;
  let rpcServer: Server | null = null;
  let rpcUrl = '';
  const network = {
    sellerNode: null as AntseedNode | null,
    buyerNode: null as AntseedNode | null,
    get rpcCallLog() { return rpcCallLog; },
    setupRpc,
    setupProxyNetwork,
  };

  beforeAll(async () => {
    await execFileAsync('pnpm', ['--filter', '@antseed/node', 'build'], {
      cwd: join(import.meta.dirname, '..', '..', '..'),
    });
    tempHomeDir = await mkdtemp(join(tmpdir(), 'antseed-home-'));
    process.env['HOME'] = tempHomeDir;
    process.env['USERPROFILE'] = tempHomeDir;
  });

  afterEach(async () => {
    try { if (proxy) { await proxy.stop(); proxy = null; } } catch {}
    try { if (network.buyerNode) { await network.buyerNode.stop(); network.buyerNode = null; } } catch {}
    try { if (network.sellerNode) { await network.sellerNode.stop(); network.sellerNode = null; } } catch {}
    try { if (bootstrap) { await bootstrap.stop(); bootstrap = null; } } catch {}
    try { if (sellerDataDir) { await rm(sellerDataDir, { recursive: true, force: true }); sellerDataDir = null; } } catch {}
    try { if (buyerDataDir) { await rm(buyerDataDir, { recursive: true, force: true }); buyerDataDir = null; } } catch {}
    if (rpcServer) {
      await new Promise<void>((resolve) => rpcServer!.close(() => resolve()));
      rpcServer = null;
    }
    rpcUrl = '';
    rpcCallLog = [];
    mockChannelActive = false;
  });

  async function setupRpc(): Promise<void> {
    const rpc = await createMockRpcServer();
    rpcServer = rpc.server;
    rpcUrl = rpc.url;
    rpcCallLog = [];
    mockChannelActive = false;
  }

  async function setupProxyNetwork<ProviderType extends Provider = MockOpenAIImageProvider>(provider?: ProviderType): Promise<{
    provider: ProviderType;
    port: number;
    discoveredSeller: PeerInfo;
  }> {
    bootstrap = await createLocalBootstrap();

    sellerDataDir = await mkdtemp(join(tmpdir(), `antseed-seller-${label}-pay-`));
    const sellerProvider = provider ?? new MockOpenAIImageProvider() as unknown as ProviderType;
    const sellerNode = new AntseedNode({
      role: 'seller',
      dataDir: sellerDataDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl),
    });
    network.sellerNode = sellerNode;
    sellerNode.registerProvider(sellerProvider);
    await sellerNode.start();

    buyerDataDir = await mkdtemp(join(tmpdir(), `antseed-buyer-${label}-pay-`));
    const buyerNode = new AntseedNode({
      role: 'buyer',
      dataDir: buyerDataDir,
      dhtPort: 0,
      bootstrapNodes: bootstrap.bootstrapConfig,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: makePaymentsConfig(rpcUrl),
    });
    network.buyerNode = buyerNode;
    await buyerNode.start();

    await waitForPeers(buyerNode, 1);
    const peers = await buyerNode.discoverPeers();
    const discoveredSeller = peers.find((peer) => peer.peerId === sellerNode.peerId);
    expect(discoveredSeller).toBeDefined();

    const port = await getFreePort();
    const { BuyerProxy } = await import('../../../apps/cli/src/proxy/buyer-proxy.js');
    proxy = new BuyerProxy({
      node: buyerNode,
      port,
      dataDir: buyerDataDir,
      backgroundRefreshIntervalMs: 60_000,
      peerCacheTtlMs: 1_000,
    });
    await proxy.start();

    return { provider: sellerProvider, port, discoveredSeller: discoveredSeller! };
  }

  return network;
}

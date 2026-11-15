import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FetchRequest, JsonRpcProvider, keccak256, makeError, Network, Wallet } from 'ethers';
import { ChannelsClient } from './channels-client.js';
import { fetchWithDeadline, StaggeredFallbackProvider } from './base-evm-client.js';

const CHAIN_ID = 8453;
const servers: Server[] = [];
const timers: ReturnType<typeof setInterval>[] = [];

afterEach(async () => {
  for (const timer of timers.splice(0)) clearInterval(timer);
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  })));
});

/**
 * A Base JSON-RPC endpoint with just enough state for one write. With `stall`, every response
 * starts but never finishes: a byte arrives every 200 ms, so the socket never goes quiet.
 */
async function rpcEndpoint(stall = false): Promise<string> {
  let nonce = 17;
  const mined = new Set<string>();
  const answer = (method: string, params: string[]): unknown => {
    switch (method) {
      case 'eth_chainId': return `0x${CHAIN_ID.toString(16)}`;
      case 'eth_blockNumber': return '0x100';
      case 'eth_getTransactionCount': return `0x${nonce.toString(16)}`;
      case 'eth_estimateGas': return '0x30000';
      case 'eth_maxPriorityFeePerGas': return '0xf4240';
      case 'eth_feeHistory': return { oldestBlock: '0x1', baseFeePerGas: [], gasUsedRatio: [], reward: [['0xf4240']] };
      case 'eth_getBlockByNumber': return {
        number: '0x100', hash: `0x${'11'.repeat(32)}`, parentHash: `0x${'22'.repeat(32)}`, timestamp: '0x6af8cbda',
        nonce: '0x0000000000000000', difficulty: '0x0', gasLimit: '0x1c9c380', gasUsed: '0x0',
        miner: `0x${'00'.repeat(20)}`, extraData: '0x', baseFeePerGas: '0x5f5e10', transactions: [],
      };
      case 'eth_sendRawTransaction': {
        const hash = keccak256(params[0]!);
        mined.add(hash);
        nonce += 1;
        return hash;
      }
      case 'eth_getTransactionReceipt': return mined.has(params[0]!) ? {
        transactionHash: params[0], transactionIndex: '0x0', blockHash: `0x${'33'.repeat(32)}`, blockNumber: '0x100',
        from: `0x${'00'.repeat(20)}`, to: `0x${'00'.repeat(20)}`, cumulativeGasUsed: '0x1', gasUsed: '0x1',
        effectiveGasPrice: '0x1', contractAddress: null, logs: [], logsBloom: `0x${'00'.repeat(256)}`, status: '0x1', type: '0x2',
      } : null;
      default: throw new Error(`unexpected ${method}`);
    }
  };
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      if (stall) {
        timers.push(setInterval(() => res.write(' '), 200));
        return;
      }
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: string[] };
      res.end(JSON.stringify({ jsonrpc: '2.0', id, result: answer(method, params) }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('BaseEvmClient with an RPC whose responses never finish', () => {
  it('sends a write through the fallbacks while the primary RPC stalls', async () => {
    const [primary, ...fallbacks] = await Promise.all([rpcEndpoint(true), rpcEndpoint(), rpcEndpoint(), rpcEndpoint()]);
    const client = new ChannelsClient({
      rpcUrl: primary!,
      fallbackRpcUrls: fallbacks,
      contractAddress: `0x${'ba'.repeat(20)}`,
      evmChainId: CHAIN_ID,
    });
    const reserve = () => client.reserve(Wallet.createRandom(), `0x${'aa'.repeat(20)}`, `0x${'01'.repeat(32)}`, 1n, 9_999_999_999n, `0x${'00'.repeat(65)}`);

    const startedAt = Date.now();
    await expect(reserve()).resolves.toMatch(/^0x[0-9a-f]{64}$/);
    // Well inside a buyer's 30 s wait for the reserve, and the signer's next write is not blocked.
    expect(Date.now() - startedAt).toBeLessThan(15_000);
    await expect(reserve()).resolves.toMatch(/^0x[0-9a-f]{64}$/);
  }, 40_000);

  it('fails a request at its deadline even though bytes keep arriving', async () => {
    const request = new FetchRequest(await rpcEndpoint(true));
    request.timeout = 1_000;
    request.getUrlFunc = fetchWithDeadline;
    request.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

    const startedAt = Date.now();
    await expect(request.send()).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });
});

describe('fetchWithDeadline', () => {
  it('sends credentials in the RPC URL as Basic auth, not in the URL', async () => {
    const seen: Array<{ url?: string; authorization?: string }> = [];
    const server = createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x100' }));
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    const request = new FetchRequest(`http://rpc-user:p%40ss@127.0.0.1:${address.port}/v1/key`);
    request.getUrlFunc = fetchWithDeadline;
    request.body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] });

    const response = await request.send();

    expect(response.statusCode).toBe(200);
    expect(seen).toEqual([{ url: '/v1/key', authorization: `Basic ${btoa('rpc-user:p@ss')}` }]);
  });
});

describe('StaggeredFallbackProvider', () => {
  const network = Network.from(CHAIN_ID);
  const backend = (blockNumber: () => Promise<number>) => {
    const provider = new JsonRpcProvider('http://127.0.0.1:1', network, { staticNetwork: network });
    vi.spyOn(provider, 'getBlockNumber').mockImplementation(blockNumber);
    return provider;
  };
  const staggered = (...providers: JsonRpcProvider[]) => new StaggeredFallbackProvider(
    providers.map((provider, i) => ({ provider, priority: i + 1, stallTimeout: 50, weight: 1 })),
    network,
    { quorum: 1 },
  );

  it('answers from the next backend once the first stalls', async () => {
    const provider = staggered(backend(() => new Promise<number>(() => {})), backend(async () => 7));
    await expect(provider.getBlockNumber()).resolves.toBe(7);
  });

  it('moves on to the next backend when one fails', async () => {
    const provider = staggered(backend(async () => { throw new Error('rate limited'); }), backend(async () => 7));
    await expect(provider.getBlockNumber()).resolves.toBe(7);
  });

  it('takes a revert from the first backend as the answer', async () => {
    const reverted = makeError('execution reverted', 'CALL_EXCEPTION');
    const second = vi.fn(async () => 7);
    const provider = staggered(backend(async () => { throw reverted; }), backend(second));
    await expect(provider.getBlockNumber()).rejects.toBe(reverted);
    expect(second).not.toHaveBeenCalled();
  });

  it('throws the first failure when every backend fails', async () => {
    const provider = staggered(
      backend(async () => { throw new Error('first'); }),
      backend(async () => { throw new Error('second'); }),
    );
    await expect(provider.getBlockNumber()).rejects.toThrow('first');
  });
});

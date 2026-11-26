import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CHAIN_CONFIGS, type ChannelsClient } from '@antseed/node';
import { ethers, FallbackProvider, type JsonRpcProvider } from 'ethers';
import { afterEach, describe, expect, it } from 'vitest';
import { workerChannelsClient, workerChannelVerifier, type WorkerChain } from './worker-chain.js';

const BUYER = '0x1000000000000000000000000000000000000001';
const SELLER = '0x2000000000000000000000000000000000000002';
const CHANNEL = `0x${'ab'.repeat(32)}`;
const CHANNELS = new ethers.Interface([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
]);

/** A JSON-RPC endpoint that answers every eth_call with an active channel of BUYER with SELLER. */
async function healthyRpc(evmChainId: number): Promise<{ url: string; calls: () => number; server: Server }> {
  let calls = 0;
  const answer = CHANNELS.encodeFunctionResult('channels', [BUYER, SELLER, 1_000_000n, 0n, ethers.ZeroHash, 0n, 0n, 0n, 1]);
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const requests = [JSON.parse(body)].flat() as Array<{ id: number; method: string }>;
      const replies = requests.map(({ id, method }) => {
        if (method === 'eth_call') calls++;
        const result = method === 'eth_chainId' ? `0x${evmChainId.toString(16)}`
          : method === 'eth_blockNumber' ? '0x10'
          : method === 'eth_call' ? answer
          : null;
        return { jsonrpc: '2.0', id, result };
      });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(Array.isArray(JSON.parse(body)) ? replies : replies[0]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls: () => calls, server };
}

describe('worker channel verification RPCs', () => {
  const servers: Server[] = [];
  afterEach(() => { for (const server of servers.splice(0)) server.close(); });

  it('keeps the chain\'s fallback RPCs by default, and drops them for an operator\'s --rpc-url', () => {
    // Every RPC the client may use: the FallbackProvider's, or the one JSON-RPC provider's.
    const urls = (client: ChannelsClient): string[] => {
      const provider = client.provider;
      const providers = provider instanceof FallbackProvider ? provider.providerConfigs.map((config) => config.provider) : [provider];
      return providers.map((p) => (p as JsonRpcProvider)._getConnection().url);
    };
    const base = CHAIN_CONFIGS['base-mainnet'] as unknown as WorkerChain;
    expect(base.fallbackRpcUrls?.length).toBeGreaterThan(0);
    expect(urls(workerChannelsClient('base-mainnet'))).toEqual([base.rpcUrl, ...base.fallbackRpcUrls!]);
    expect(urls(workerChannelsClient('base-mainnet', 'https://rpc.example.org'))).toEqual(['https://rpc.example.org']);
  });

  it('verifies a channel through a healthy fallback when the primary RPC is down', async () => {
    const fallback = await healthyRpc(8453);
    servers.push(fallback.server);
    // A port nothing listens on: every request to the primary fails.
    const dead = createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadUrl = `http://127.0.0.1:${(dead.address() as AddressInfo).port}`;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const chains: Record<string, WorkerChain> = {
      test: { channelsContractAddress: '0x3000000000000000000000000000000000000003', evmChainId: 8453, rpcUrl: deadUrl, fallbackRpcUrls: [fallback.url] },
    };
    const client = workerChannelsClient('test', undefined, undefined, chains);
    const session = await client.getSession(CHANNEL);
    expect(session.buyer.toLowerCase()).toBe(BUYER);
    expect(session.status).toBe(1);
    expect(fallback.calls()).toBeGreaterThan(0);
    // The verifier the CLI uses reads through the same client.
    expect(await workerChannelVerifier('test', undefined, undefined, chains)(CHANNEL, BUYER, SELLER)).toEqual({ deposit: 1_000_000n });
  });
});

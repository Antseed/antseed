import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { startRpcProxy } from '../stress/rpc-proxy.mjs';

/** A chain stub at block 0x10 that records the block tag of every eth_call. */
async function startChainStub(): Promise<{ url: string; callTags: unknown[]; server: Server }> {
  const callTags: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      if (body.method === 'eth_call') callTags.push(body.params?.[1]);
      const result = body.method === 'eth_blockNumber' ? '0x10' : '0x';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, callTags, server };
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<void> {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}

describe('stress harness Base-like RPC proxies', () => {
  const closers: Array<() => Promise<unknown>> = [];
  afterEach(async () => {
    while (closers.length > 0) await closers.pop()!();
  });

  it("make the buyer's reads lag after a transaction the seller sent", async () => {
    const chain = await startChainStub();
    closers.push(() => new Promise((resolve) => chain.server.close(resolve)));
    const clock = { lastTxAt: 0 };
    const options = { port: 0, upstream: chain.url, latencyMinMs: 0, latencyMaxMs: 0, slowTailRate: 0, staleReadRate: 1, chain: clock };
    const seller = await startRpcProxy(options);
    const buyer = await startRpcProxy(options);
    closers.push(seller.close, buyer.close);

    await rpc(buyer.url, 'eth_call', [{ to: '0x' + '00'.repeat(20) }, 'latest']);
    await rpc(seller.url, 'eth_sendRawTransaction', ['0x00']);
    await rpc(buyer.url, 'eth_call', [{ to: '0x' + '00'.repeat(20) }, 'latest']);

    // Before the transaction the buyer reads the head; after it, a block behind.
    expect({ tags: chain.callTags, buyerStaleReads: buyer.stats.staleReads }).toEqual({ tags: ['latest', '0xf'], buyerStaleReads: 1 });
  });
});

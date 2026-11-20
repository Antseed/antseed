import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Wallet, id } from 'ethers';
// @ts-expect-error The stress harness is plain .mjs with no type declarations.
import { startRpcProxy } from '../stress/rpc-proxy.mjs';

/** A chain stub at block 0x10 that records the block tag of every eth_call and every raw transaction sent. */
async function startChainStub(): Promise<{ url: string; callTags: unknown[]; sent: unknown[]; server: Server }> {
  const callTags: unknown[] = [];
  const sent: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw) as { id: number; method: string; params?: unknown[] };
      if (body.method === 'eth_call') callTags.push(body.params?.[1]);
      if (body.method === 'eth_sendRawTransaction') sent.push(body.params?.[0]);
      const result = body.method === 'eth_blockNumber' ? '0x10' : '0x';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, callTags, sent, server };
}

async function rpc(url: string, method: string, params: unknown[] = []): Promise<{ result?: unknown; error?: { message: string } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  return res.json() as Promise<{ result?: unknown; error?: { message: string } }>;
}

/** A signed transaction whose calldata starts with `signature`'s selector. */
function signedCall(signature: string, nonce: number): Promise<string> {
  return new Wallet('0x' + '11'.repeat(32)).signTransaction({
    to: '0x' + '22'.repeat(20), data: id(signature).slice(0, 10) + '00'.repeat(32), chainId: 1, nonce, gasLimit: 100_000, gasPrice: 1,
  });
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

  it('hold back the first topUp() transaction until it is dropped, and never send it', async () => {
    const chain = await startChainStub();
    closers.push(() => new Promise((resolve) => chain.server.close(resolve)));
    const proxy = await startRpcProxy({ port: 0, upstream: chain.url, latencyMinMs: 0, latencyMaxMs: 0, slowTailRate: 0 });
    closers.push(proxy.close);
    const settle = await signedCall('settle(bytes32,uint128,bytes,bytes)', 0);
    const topUp = await signedCall('topUp(bytes32,uint128,bytes,bytes,uint128,uint256,bytes)', 1);
    const laterTopUp = await signedCall('topUp(bytes32,uint128,bytes,bytes,uint128,uint256,bytes)', 2);

    const held = proxy.holdTopUp();
    await rpc(proxy.url, 'eth_sendRawTransaction', [settle]);
    const send = rpc(proxy.url, 'eth_sendRawTransaction', [topUp]);
    await held;
    expect(proxy.topUpHoldState().heldAt).toBeTypeOf('number');
    expect(proxy.dropHeldTopUp()).toBe(true);
    const answer = await send;
    await rpc(proxy.url, 'eth_sendRawTransaction', [laterTopUp]);

    // Other transactions go through; the held one never reaches the chain, and only the first is held.
    expect({ sent: chain.sent, error: answer.error?.message, held: proxy.stats.heldTopUps, armed: proxy.topUpHoldState().armed })
      .toEqual({ sent: [settle, laterTopUp], error: expect.stringContaining('dropped'), held: 1, armed: false });
  });
});

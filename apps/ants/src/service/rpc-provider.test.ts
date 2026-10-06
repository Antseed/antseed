import { describe, expect, it, vi } from 'vitest';
import { RotatingJsonRpcProvider, type RpcTransportResponse } from './rpc-provider.js';

const ok = (id: unknown, result: string): RpcTransportResponse => ({ status: 200, body: { jsonrpc: '2.0', id, result } });
const throttled: RpcTransportResponse = { status: 429, body: null };
const rateLimitBody: RpcTransportResponse = { status: 200, body: { jsonrpc: '2.0', id: 1, error: { code: -32005, message: 'rate limit exceeded' } } };

function build(responses: Record<string, RpcTransportResponse[]>, clock: { now: number }) {
  const sent: string[] = [];
  const provider = new RotatingJsonRpcProvider(Object.keys(responses), 8453, {
    now: () => clock.now,
    transport: async (url, body) => {
      sent.push(url);
      const next = responses[url]!.shift();
      if (!next) throw new Error(`${url} unreachable`);
      const id = (JSON.parse(body) as { id: unknown }).id;
      return next.status === 200 && next.body && typeof next.body === 'object' && 'result' in (next.body as object) ? ok(id, (next.body as { result: string }).result) : next;
    },
  });
  return { provider, sent };
}

describe('RotatingJsonRpcProvider', () => {
  it('coalesces identical concurrent reads across views, preserving response ids', async () => {
    const transport = vi.fn(async (_url: string, body: string) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return ok(JSON.parse(body).id, '0x1');
    });
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const payload = { jsonrpc: '2.0', method: 'eth_call', params: [{ to: '0x1', data: '0x1234' }, 'latest'] };
    const responses = await Promise.all([1, 2, 3].map(id => provider._send({ ...payload, id })));
    expect(responses.map(response => response[0]!.id)).toEqual([1, 2, 3]);
    expect(transport).toHaveBeenCalledTimes(1);
    await provider._send({ ...payload, id: 4 });
    expect(transport).toHaveBeenCalledTimes(2);
    provider.destroy();
  });

  it('remembers deployed contract code but never an empty account', async () => {
    const transport = vi.fn(async (_url: string, body: string) => {
      const { id, params } = JSON.parse(body);
      return ok(id, params[0] === '0xcontract' ? '0x6001' : '0x');
    });
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const code = (address: string, id: number) => provider._send({ jsonrpc: '2.0', id, method: 'eth_getCode', params: [address, 'latest'] });
    expect((await code('0xcontract', 1))[0]!.result).toBe('0x6001');
    expect((await code('0xcontract', 2))[0]).toEqual({ id: 2, result: '0x6001' });
    expect(transport).toHaveBeenCalledTimes(1);
    await code('0xaccount', 3); await code('0xaccount', 4);
    expect(transport).toHaveBeenCalledTimes(3);
    provider.destroy();
  });

  it('does not coalesce different blocks, callers, or transactions', async () => {
    const transport = vi.fn(async (_url: string, body: string) => ok(JSON.parse(body).id, '0x1'));
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    await Promise.all([
      { method: 'eth_call', params: [{ to: '0x1', from: '0x2' }, 'latest'] },
      { method: 'eth_call', params: [{ to: '0x1', from: '0x3' }, 'latest'] },
      { method: 'eth_call', params: [{ to: '0x1', from: '0x2' }, '0x10'] },
      { method: 'eth_sendRawTransaction', params: ['0x1234'] },
      { method: 'eth_sendRawTransaction', params: ['0x1234'] },
    ].map((payload, id) => provider._send({ jsonrpc: '2.0', ...payload, id })));
    expect(transport).toHaveBeenCalledTimes(5);
    provider.destroy();
  });

  it('evicts failed reads so a later attempt can recover', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [throttled, ok(1, '0x1')] }, clock);
    const payload = { jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: ['0x1', 'latest'] };
    await expect(provider._send(payload)).rejects.toThrow(/rate limiting/);
    clock.now += 25_000;
    expect(await provider._send(payload)).toEqual([{ jsonrpc: '2.0', id: 1, result: '0x1' }]);
    expect(sent).toHaveLength(2);
    provider.destroy();
  });

  it('deduplicates public send calls and preserves JSON-RPC errors for each caller', async () => {
    const transport = vi.fn(async (_url: string, body: string) => {
      await new Promise(resolve => setTimeout(resolve, 5));
      return { status: 200, body: { jsonrpc: '2.0', id: JSON.parse(body).id, error: { code: -32602, message: 'invalid params' } } };
    });
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const responses = await Promise.allSettled([1, 2, 3].map(() => provider.send('eth_getCode', ['0x1', 'latest'])));
    expect(responses.every(response => response.status === 'rejected')).toBe(true);
    expect(transport).toHaveBeenCalledTimes(1);
    await expect(provider.send('eth_getCode', ['0x1', 'latest'])).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(2);
    provider.destroy();
  });

  it('coalesces slow contract reads after the ethers short-lived cache expires', async () => {
    const transport = vi.fn(async (_url: string, body: string) => {
      await new Promise(resolve => setTimeout(resolve, 500));
      return ok(JSON.parse(body).id, '0x1234');
    });
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const transaction = { to: '0x0000000000000000000000000000000000000001', data: '0x1234' };
    const first = provider.call(transaction);
    await new Promise(resolve => setTimeout(resolve, 300));
    const second = provider.call(transaction);
    expect(await Promise.all([first, second])).toEqual(['0x1234', '0x1234']);
    expect(transport).toHaveBeenCalledTimes(1);
    provider.destroy();
  });

  it('does not send queued calls to an endpoint that cooled down while they waited', async () => {
    const transport = vi.fn(async () => throttled);
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const responses = await Promise.allSettled(Array.from({ length: 6 }, (_, id) => provider._send({ id, jsonrpc: '2.0', method: 'eth_blockNumber', params: [] })));
    expect(responses.every(response => response.status === 'rejected')).toBe(true);
    expect(transport.mock.calls.length).toBeLessThanOrEqual(4);
    provider.destroy();
  });

  it('starts fresh reads after invalidation without old completions evicting new reads', async () => {
    const releases: Array<() => void> = [];
    const transport = vi.fn(async (_url: string, body: string) => {
      await new Promise<void>(resolve => releases.push(resolve));
      return ok(JSON.parse(body).id, '0x1');
    });
    const provider = new RotatingJsonRpcProvider(['https://a'], 8453, { transport });
    const payload = { jsonrpc: '2.0', method: 'eth_getCode', params: ['0x1', 'latest'] };
    const old = provider._send({ ...payload, id: 1 });
    await vi.waitFor(() => expect(releases).toHaveLength(1));
    provider.invalidateReads();
    const fresh = provider._send({ ...payload, id: 2 });
    await vi.waitFor(() => expect(releases).toHaveLength(2));
    releases[0]!();
    await old;
    const shared = provider._send({ ...payload, id: 3 });
    releases[1]!();
    expect((await Promise.all([fresh, shared])).map(response => response[0]!.id)).toEqual([2, 3]);
    expect(transport).toHaveBeenCalledTimes(2);
    provider.destroy();
  });

  it('moves to the next endpoint on 429, cools the throttled one down, and returns to it later', async () => {
    const clock = { now: 1_000_000 };
    const { provider, sent } = build({ 'https://a': [throttled, ok(1, '0x2')], 'https://b': [ok(1, '0x1'), ok(1, '0x1')] }, clock);
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
    expect(sent).toEqual(['https://a', 'https://b']);
    expect(provider.activeUrl).toBe('https://b');
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
    expect(sent).toEqual(['https://a', 'https://b', 'https://b']);
    clock.now += 25_000;
    expect(provider.activeUrl).toBe('https://a');
    expect(await provider.send('eth_blockNumber', [])).toBe('0x2');
  });

  it('treats a JSON-RPC rate-limit error and a transport failure as throttling too', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [rateLimitBody], 'https://b': [], 'https://c': [ok(1, '0x3')] }, clock);
    expect(await provider.send('eth_blockNumber', [])).toBe('0x3');
    expect(sent).toEqual(['https://a', 'https://b', 'https://c']);
  });

  it('fails fast when every endpoint throttles, and again while they cool down', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [throttled, ok(1, '0x1')], 'https://b': [throttled] }, clock);
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(/rate limiting/);
    await expect(provider.send('eth_blockNumber', [])).rejects.toThrow(/rate limiting/);
    expect(sent).toEqual(['https://a', 'https://b']);
    clock.now += 25_000;
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
  });

  it('rotates away from a server failure', async () => {
    const clock = { now: 0 };
    const { provider, sent } = build({ 'https://a': [{ status: 500, body: null }], 'https://b': [ok(1, '0x1')] }, clock);
    expect(await provider.send('eth_blockNumber', [])).toBe('0x1');
    expect(sent).toEqual(['https://a', 'https://b']);
  });
});

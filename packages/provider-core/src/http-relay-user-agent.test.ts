import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { SerializedHttpRequest } from '@antseed/node';
import pkg from '../package.json' with { type: 'json' };
import { HttpRelay, type RelayConfig } from './http-relay.js';

const SELLER_UA = `antseed-seller/${pkg.version}`;
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

/** A real upstream, so the test sees the user agent fetch puts on the wire. */
async function upstream(): Promise<{ baseUrl: string; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

async function relayFrom(headers: Record<string, string>, config: Partial<RelayConfig> = {}): Promise<IncomingHttpHeaders> {
  const { baseUrl, seen } = await upstream();
  const relay = new HttpRelay({
    baseUrl,
    authHeaderName: 'authorization',
    authHeaderValue: 'Bearer sk-seller',
    maxConcurrency: 1,
    allowedServices: [],
    ...config,
  }, { onResponse: () => undefined });
  const request: SerializedHttpRequest = {
    requestId: 'req-ua',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json', ...headers },
    body: new TextEncoder().encode(JSON.stringify({ model: 'example-model', messages: [] })),
  };
  await relay.handleRequest(request);
  expect(seen).toHaveLength(1);
  return seen[0]!;
}

describe('HttpRelay user agent', () => {
  it("sends the seller's user agent upstream instead of the buyer's", async () => {
    const sent = await relayFrom({ 'user-agent': 'Python-urllib/3.12' });
    expect(sent['user-agent']).toBe(SELLER_UA);
  });

  it("drops the buyer's user agent whatever its case", async () => {
    const sent = await relayFrom({ 'User-Agent': 'Python-urllib/3.12' });
    expect(sent['user-agent']).toBe(SELLER_UA);
  });

  it("sends the seller's user agent when the buyer sent none", async () => {
    const sent = await relayFrom({});
    expect(sent['user-agent']).toBe(SELLER_UA);
  });

  it('keeps a user agent the plugin forces in extraHeaders', async () => {
    const sent = await relayFrom(
      { 'user-agent': 'Python-urllib/3.12' },
      { extraHeaders: { 'user-agent': 'claude-cli/1.0.0' } },
    );
    expect(sent['user-agent']).toBe('claude-cli/1.0.0');
  });

  it('keeps a user agent the plugin sets in defaultHeaders', async () => {
    const sent = await relayFrom(
      { 'user-agent': 'Python-urllib/3.12' },
      { defaultHeaders: { 'User-Agent': 'example-seller/2' } },
    );
    expect(sent['user-agent']).toBe('example-seller/2');
  });

  it("forwards the buyer's user agent when it is the client the plugin forwards", async () => {
    const sent = await relayFrom({ 'User-Agent': 'claude-cli/1.0.0 (external, cli)' }, { forwardClientUserAgent: /^claude-cli\// });
    expect(sent['user-agent']).toBe('claude-cli/1.0.0 (external, cli)');
  });

  it("drops any other buyer user agent even when the plugin forwards one client's", async () => {
    const sent = await relayFrom({ 'user-agent': 'Python-urllib/3.12' }, { forwardClientUserAgent: /^claude-cli\// });
    expect(sent['user-agent']).toBe(SELLER_UA);
  });

  it("sends the seller's user agent when a forwarding plugin's buyer sent none", async () => {
    const sent = await relayFrom({}, { forwardClientUserAgent: /^claude-cli\// });
    expect(sent['user-agent']).toBe(SELLER_UA);
  });

  it("sends the seller's user agent to a fallback upstream too", async () => {
    const primary = createServer((req, res) => { req.resume(); res.writeHead(503); res.end(); });
    await new Promise<void>((resolve) => primary.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => primary.close(() => resolve())));
    const fallback = await upstream();
    const relay = new HttpRelay({
      baseUrl: `http://127.0.0.1:${(primary.address() as AddressInfo).port}`,
      authHeaderName: 'authorization',
      authHeaderValue: 'Bearer sk-seller',
      maxConcurrency: 1,
      allowedServices: [],
      fallbackUpstreams: [{ baseUrl: fallback.baseUrl }],
    }, { onResponse: () => undefined });
    await relay.handleRequest({
      requestId: 'req-ua-fallback',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json', 'user-agent': 'Python-urllib/3.12' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'example-model', messages: [] })),
    });
    expect(fallback.seen.map((headers) => headers['user-agent'])).toEqual([SELLER_UA]);
  });
});

import { createServer, type RequestListener } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';
import { BaseProvider } from './base-provider.js';
import { HttpRelay, type RelayConfig } from './http-relay.js';

const TIMEOUT_MS = 100;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function request(requestId: string, path = '/stall'): SerializedHttpRequest {
  return {
    requestId,
    method: 'POST',
    path,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'test-model', messages: [] })),
  };
}

function config(baseUrl: string, overrides: Partial<RelayConfig> = {}): RelayConfig {
  return {
    baseUrl,
    authHeaderName: 'authorization',
    authHeaderValue: 'Bearer test-only',
    allowedServices: ['test-model'],
    maxConcurrency: 1,
    timeoutMs: TIMEOUT_MS,
    ...overrides,
  };
}

async function completesWithin(pending: Promise<unknown>, ms = 1_000): Promise<boolean> {
  const controller = new AbortController();
  try {
    return await Promise.race([
      pending.then(() => true),
      delay(ms, false, { signal: controller.signal }),
    ]);
  } finally {
    controller.abort();
  }
}

/** Real fetch/body cancellation against an ephemeral loopback server, never a seller. */
async function withUpstream(
  listener: RequestListener,
  run: (url: string, track: <T>(pending: Promise<T>) => Promise<T>) => Promise<void>,
): Promise<void> {
  const server = createServer(listener);
  const pending: Promise<unknown>[] = [];
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a loopback TCP address');
  try {
    await run(`http://127.0.0.1:${address.port}`, <T>(operation: Promise<T>) => {
      pending.push(operation.catch(() => undefined));
      return operation;
    });
  } finally {
    // Also unstick the unpatched implementation when a regression assertion fails.
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await Promise.allSettled(pending);
  }
}

describe('HttpRelay response-body deadlines', () => {
  it.each([1, 3])('releases relay and provider capacity after %i JSON bodies stall after headers', async (maxConcurrency) => {
    await withUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/stall') res.write('{"partial":');
      else res.end('{"ok":true}');
    }, async (baseUrl, track) => {
      const provider = new BaseProvider({
        name: 'test', services: ['test-model'],
        pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
        relay: config(baseUrl, { maxConcurrency }),
      });
      const first = Array.from({ length: maxConcurrency }, (_, index) =>
        track(provider.handleRequest(request(`stalled-${index}`))));
      const completed = await completesWithin(Promise.all(first));
      const capacityAfterDeadline = provider.getCapacity().current;
      const next = await provider.handleRequest(request('next', '/ok'));

      expect({ completed, capacityAfterDeadline, nextStatus: next.statusCode }).toEqual({
        completed: true, capacityAfterDeadline: 0, nextStatus: 200,
      });
      for (const failed of await Promise.all(first)) {
        expect(failed.statusCode).toBe(502);
        expect(new TextDecoder().decode(failed.body)).toContain(`timed out after ${TIMEOUT_MS}ms`);
      }
      expect(provider.getCapacity().current).toBe(0);
    });
  });

  it('ends a stalled SSE stream once, frees capacity, and never replays it to a fallback', async () => {
    let fallbackCalls = 0;
    await withUpstream((req, res) => {
      req.resume();
      if (req.url?.startsWith('/fallback')) fallbackCalls++;
      if (req.url === '/primary/stall') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('data: {"partial":true}\n\n');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    }, async (baseUrl, track) => {
      const responses: SerializedHttpResponse[] = [];
      const chunks: SerializedHttpResponseChunk[] = [];
      const relay = new HttpRelay(config(`${baseUrl}/primary`, {
        fallbackUpstreams: [{ baseUrl: `${baseUrl}/fallback` }],
      }), {
        onResponse: (response) => responses.push(response),
        onResponseChunk: (chunk) => chunks.push(chunk),
      });
      const first = track(relay.handleRequest(request('stalled')));
      const completed = await completesWithin(first);
      const activeAfterDeadline = relay.getActiveCount();
      await relay.handleRequest(request('next', '/ok'));

      expect({ completed, activeAfterDeadline, nextStatus: responses.at(-1)?.statusCode }).toEqual({
        completed: true, activeAfterDeadline: 0, nextStatus: 200,
      });
      expect(responses.filter((response) => response.requestId === 'stalled')).toHaveLength(1);
      expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
      const text = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
      expect(text).toContain('"partial":true');
      expect(text).toContain(`event: error\ndata: Upstream request timed out after ${TIMEOUT_MS}ms`);
      expect(fallbackCalls).toBe(0);
      expect(relay.getActiveCount()).toBe(0);
    });
  });

  it('fails over a stalled buffered body before delivering anything to the buyer', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    await withUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url?.startsWith('/primary')) {
        primaryCalls++;
        res.write('{"partial":');
      } else {
        fallbackCalls++;
        res.end('{"source":"fallback"}');
      }
    }, async (baseUrl, track) => {
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(config(`${baseUrl}/primary`, {
        fallbackUpstreams: [{ baseUrl: `${baseUrl}/fallback` }],
      }), { onResponse: (response) => responses.push(response) });
      const first = track(relay.handleRequest(request('stalled')));
      expect(await completesWithin(first)).toBe(true);
      expect({ primaryCalls, fallbackCalls, active: relay.getActiveCount() }).toEqual({
        primaryCalls: 1, fallbackCalls: 1, active: 0,
      });
      expect(responses).toHaveLength(1);
      expect(responses[0]?.statusCode).toBe(200);
      expect(new TextDecoder().decode(responses[0]?.body)).toBe('{"source":"fallback"}');
    });
  });

  it('still bounds fetches that never return headers', async () => {
    await withUpstream((req, res) => {
      req.resume();
      if (req.url === '/ok') res.end('{"ok":true}');
    }, async (baseUrl, track) => {
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(config(baseUrl), { onResponse: (response) => responses.push(response) });
      const first = track(relay.handleRequest(request('stalled')));
      expect(await completesWithin(first)).toBe(true);
      expect(responses[0]?.statusCode).toBe(502);
      expect(new TextDecoder().decode(responses[0]?.body)).toContain(`timed out after ${TIMEOUT_MS}ms`);
      await relay.handleRequest(request('next', '/ok'));
      expect(responses.at(-1)?.statusCode).toBe(200);
      expect(relay.getActiveCount()).toBe(0);
    });
  });

  it.each(['5xx retry', '401 refresh', 'fallback'] as const)('aborts an unread error body before %s', async (mode) => {
    let calls = 0;
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    await withUpstream((req, res) => {
      req.resume();
      calls++;
      if (calls === 1) {
        res.once('close', markClosed);
        res.writeHead(mode === '401 refresh' ? 401 : 503, { 'content-type': 'application/json' });
        res.write('{"error":');
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }
    }, async (baseUrl, track) => {
      const overrides: Partial<RelayConfig> = mode === '5xx retry'
        ? { retryOn5xx: 1, retryBaseDelayMs: 1 }
        : mode === '401 refresh'
          ? { retryOn401: true, tokenProvider: {
            getToken: async () => 'old-test-token',
            forceRefresh: async () => 'new-test-token',
            stop: () => undefined,
          } }
          : { fallbackUpstreams: [{ baseUrl: `${baseUrl}/fallback` }] };
      const responses: SerializedHttpResponse[] = [];
      // An unread body's own deadline must not be needed to clean up a retry.
      const relay = new HttpRelay(config(baseUrl, { ...overrides, timeoutMs: 5_000 }), {
        onResponse: (response) => responses.push(response),
      });
      await track(relay.handleRequest(request('retry')));
      expect(await completesWithin(closed)).toBe(true);
      expect(calls).toBe(2);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.statusCode).toBe(200);
      expect(relay.getActiveCount()).toBe(0);
    });
  });

  it.each(['application/json', 'text/event-stream'])('clears the deadline after a complete %s response', async (contentType) => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: complete\n\n', {
      headers: { 'content-type': contentType },
    })));
    const relay = new HttpRelay(config('https://upstream.invalid'), { onResponse: () => undefined });
    await relay.handleRequest(request('complete'));
    expect(relay.getActiveCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['application/json', 'text/event-stream'])('does not truncate a progressing %s body at a total-duration limit', async (contentType) => {
    const isSSE = contentType === 'text/event-stream';
    await withUpstream((req, res) => {
      req.resume();
      res.writeHead(200, { 'content-type': contentType });
      res.write(isSSE ? ': start\n\n' : '[');
      void (async () => {
        for (let index = 0; index < 5; index++) {
          await delay(40);
          if (res.destroyed) return;
          res.write(isSSE ? `data: ${index}\n\n` : `${index ? ',' : ''}${index}`);
        }
        res.end(isSSE ? 'data: [DONE]\n\n' : ']');
      })();
    }, async (baseUrl, track) => {
      const responses: SerializedHttpResponse[] = [];
      const chunks: SerializedHttpResponseChunk[] = [];
      const relay = new HttpRelay(config(baseUrl), {
        onResponse: (response) => responses.push(response),
        onResponseChunk: (chunk) => chunks.push(chunk),
      });
      const pending = track(relay.handleRequest(request('progress')));
      expect(await completesWithin(pending)).toBe(true);
      expect(responses).toHaveLength(1);
      expect(responses[0]?.statusCode).toBe(200);
      if (isSSE) {
        const body = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
        expect(body).toContain('data: [DONE]');
        expect(body).not.toContain('event: error');
        expect(chunks.filter((chunk) => chunk.done)).toHaveLength(1);
      } else {
        expect(JSON.parse(new TextDecoder().decode(responses[0]?.body))).toEqual([0, 1, 2, 3, 4]);
      }
      expect(relay.getActiveCount()).toBe(0);
    });
  });
});

describe('HttpRelay redirects', () => {
  it.each([307, 308])('does not follow a %i, so the buyer request never reaches another destination', async (status) => {
    let collected = 0;
    await withUpstream((req, res) => {
      req.resume();
      if (req.url === '/collect') {
        collected++;
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(status, { location: `http://${req.headers.host}/collect` });
      res.end();
    }, async (baseUrl) => {
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(config(baseUrl), { onResponse: (response) => responses.push(response) });
      await relay.handleRequest(request('redirected', '/v1/chat/completions'));
      expect(collected).toBe(0);
      expect(responses[0]?.statusCode).not.toBe(200);
    });
  });
});

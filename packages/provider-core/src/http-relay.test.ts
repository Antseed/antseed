import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpRelay, type RelayConfig, type RelayCallbacks } from './http-relay.js';
import type { SerializedHttpRequest, SerializedHttpResponse, SerializedHttpResponseChunk } from '@antseed/node';

function makeRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-20250514', messages: [] })),
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<RelayConfig>): RelayConfig {
  return {
    baseUrl: 'https://api.example.com',
    authHeaderName: 'x-api-key',
    authHeaderValue: 'sk-test-key',
    maxConcurrency: 2,
    allowedServices: ['claude-sonnet-4-20250514'],
    ...overrides,
  };
}

describe('HttpRelay', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('relays a successful non-streaming response', async () => {
    const responseBody = JSON.stringify({ id: 'msg_1', content: [{ text: 'Hello' }] });
    fetchMock.mockResolvedValueOnce(new Response(responseBody, {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'upstream-1' },
    }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(responses[0]!.requestId).toBe('req-1');
    expect(responses[0]!.headers['content-type']).toBe('application/json');

    // Verify fetch was called with the right URL and auth
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/messages');
    expect((opts.headers as Record<string, string>)['x-api-key']).toBe('sk-test-key');
  });

  it('rejects disallowed service', async () => {
    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-4', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(403);
    const body = JSON.parse(new TextDecoder().decode(responses[0]!.body)) as { error: string };
    expect(body.error).toContain('not in the allowed list');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('allows any service when allowedServices is empty', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ allowedServices: [] }), callbacks);
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'any-model', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
  });

  it('does not inject chat-only fields into image requests', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const relay = new HttpRelay(
      makeConfig({
        allowedServices: ['venice-sd35'],
        injectJsonFields: {
          venice_parameters: { include_venice_system_prompt: false },
        },
      }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({
      path: '/v1/images/generations',
      body: new TextEncoder().encode(JSON.stringify({
        model: 'venice-sd35',
        prompt: 'A seedling',
      })),
    }));

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(
      new TextDecoder().decode(options.body as Uint8Array),
    ) as Record<string, unknown>;
    expect(upstreamBody).toEqual({ model: 'venice-sd35', prompt: 'A seedling' });
  });

  it('judges a media request by the path it sends, however the path is written', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ allowedServices: ['venice-sd35'], injectJsonFields: { venice_parameters: { include_venice_system_prompt: false } } }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({
      path: '/v1/./images/generations',
      body: new TextEncoder().encode(JSON.stringify({ model: 'venice-sd35', prompt: 'A seedling' })),
    }));

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array))).toEqual({ model: 'venice-sd35', prompt: 'A seedling' });
  });

  it('applies a path rewrite to the path it sends, however the path is written', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ pathRewrite: { '/v1/chat/completions': '/v4/chat/completions' } }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({ path: '/v1/./chat/completions' }));

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v4/chat/completions');
  });

  it('matches a path rewrite key exactly, query string included', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ pathRewrite: { '/v1/chat/completions?api-version=1': '/v4/chat/completions?api-version=2' } }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({ path: '/v1/chat/completions?api-version=1' }));
    await relay.handleRequest(makeRequest({ path: '/v1/chat/completions?client_version=1' }));

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'https://api.example.com/v4/chat/completions?api-version=2',
      'https://api.example.com/v1/chat/completions?client_version=1',
    ]);
  });

  it('asks for usage when a path rewrite points at a completions path', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ pathRewrite: { '/generate': '/v1/chat/completions' } }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({ path: '/generate', body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-20250514', stream: true })) }));

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/chat/completions');
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array)).stream_options).toEqual({ include_usage: true });
  });

  it('asks for usage on a completions path rewritten to one that does not look like it', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ pathRewrite: { '/v1/chat/completions': '/v1/text/chatcompletion_v2' } }),
      { onResponse: () => undefined },
    );

    await relay.handleRequest(makeRequest({ path: '/v1/chat/completions', body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-20250514', stream: true })) }));

    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.example.com/v1/text/chatcompletion_v2');
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array)).stream_options).toEqual({ include_usage: true });
  });

  it('does not inject chat-only fields into speech requests', async () => {
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { status: 200, headers: { 'content-type': 'audio/mpeg' } }));

    const responses: SerializedHttpResponse[] = [];
    const relay = new HttpRelay(
      makeConfig({
        allowedServices: ['tts-kokoro'],
        injectJsonFields: { venice_parameters: { include_venice_system_prompt: false } },
      }),
      { onResponse: (response) => responses.push(response) },
    );

    await relay.handleRequest(makeRequest({
      path: '/v1/audio/speech',
      body: new TextEncoder().encode(JSON.stringify({ model: 'tts-kokoro', input: 'Hi', voice: 'af_sky' })),
    }));

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array))).toEqual({ model: 'tts-kokoro', input: 'Hi', voice: 'af_sky' });
    expect(Array.from(responses[0]!.body)).toEqual([1, 2]);
    expect(responses[0]!.headers['content-type']).toBe('audio/mpeg');
  });

  it('rewrites a multipart modelId field in place instead of adding a model field', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    const relay = new HttpRelay(
      makeConfig({ allowedServices: ['edit-model'] }),
      { onResponse: () => undefined },
    );
    const form = new FormData();
    form.append('prompt', 'merge them');
    form.append('modelId', 'edit-model');
    form.append('images', new Blob([new Uint8Array([1])], { type: 'image/png' }), 'a.png');
    const webRequest = new Request('https://buyer.invalid/v1/image/multi-edit', { method: 'POST', body: form });

    await relay.handleRequest(makeRequest({
      path: '/v1/image/multi-edit',
      headers: { 'content-type': webRequest.headers.get('content-type') ?? '', 'x-antseed-service': 'edit-model' },
      body: new Uint8Array(await webRequest.arrayBuffer()),
    }));

    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = options.headers as Record<string, string>;
    const forwarded = await new Response(options.body, { headers: { 'content-type': sentHeaders['content-type'] ?? '' } }).formData();
    expect(forwarded.get('modelId')).toBe('edit-model');
    expect(forwarded.has('model')).toBe(false);
  });

  it('rewrites announced service names to upstream service IDs before relay', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(
      makeConfig({
        allowedServices: ['kimi2.5'],
        serviceRewriteMap: {
          'kimi2.5': 'together/kimi2.5',
        },
      }),
      callbacks,
    );

    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'kimi2.5', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = opts.body as Uint8Array | undefined;
    const parsed = JSON.parse(new TextDecoder().decode(body ?? new Uint8Array(0))) as { model?: string };
    expect(parsed.model).toBe('together/kimi2.5');
  });

  it('preserves and rewrites model fields in multipart image edits', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const relay = new HttpRelay(
      makeConfig({
        allowedServices: ['gpt-image-2'],
        serviceRewriteMap: { 'gpt-image-2': 'upstream/gpt-image-2' },
      }),
      { onResponse: (response) => responses.push(response) },
    );
    const form = new FormData();
    form.append('prompt', 'Now with a blue background');
    form.append('image', new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }), 'source.png');
    const webRequest = new Request('https://buyer.invalid/v1/images/edits', { method: 'POST', body: form });

    await relay.handleRequest(makeRequest({
      path: '/v1/images/edits',
      headers: {
        'content-type': webRequest.headers.get('content-type') ?? '',
        'x-antseed-service': 'gpt-image-2',
      },
      body: new Uint8Array(await webRequest.arrayBuffer()),
    }));

    expect(responses[0]?.statusCode).toBe(200);
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = options.headers as Record<string, string>;
    expect(sentHeaders['x-antseed-service']).toBeUndefined();
    const forwarded = await new Response(options.body, {
      headers: { 'content-type': sentHeaders['content-type'] ?? '' },
    }).formData();
    expect(forwarded.get('model')).toBe('upstream/gpt-image-2');
    expect(forwarded.get('prompt')).toBe('Now with a blue background');
    expect(forwarded.get('image')).toBeInstanceOf(Blob);
  });

  it('enforces concurrency limit', async () => {
    // Create a fetch that blocks until we resolve it
    let resolveFirst!: (value: Response) => void;
    const firstFetch = new Promise<Response>((resolve) => { resolveFirst = resolve; });

    fetchMock.mockReturnValueOnce(firstFetch);

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ maxConcurrency: 1 }), callbacks);

    // Start first request (fills concurrency) — do NOT await
    const p1 = relay.handleRequest(makeRequest({ requestId: 'req-1' }));

    // Yield to allow the first handleRequest to progress to its await
    await new Promise((r) => setTimeout(r, 0));

    // Active count should be 1 now
    expect(relay.getActiveCount()).toBe(1);

    // Second request should be rejected (concurrency full)
    await relay.handleRequest(makeRequest({ requestId: 'req-2' }));
    expect(responses).toHaveLength(1);
    expect(responses[0]!.requestId).toBe('req-2');
    expect(responses[0]!.statusCode).toBe(429);

    // Complete first request
    resolveFirst(new Response('{}', { status: 200 }));
    await p1;
    expect(responses).toHaveLength(2);
    expect(responses[1]!.requestId).toBe('req-1');
    expect(responses[1]!.statusCode).toBe(200);

    // Now concurrency is free, third request should work
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
    await relay.handleRequest(makeRequest({ requestId: 'req-3' }));
    expect(responses).toHaveLength(3);
    expect(responses[2]!.requestId).toBe('req-3');
    expect(responses[2]!.statusCode).toBe(200);
  });

  it('strips hop-by-hop and internal headers from request', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest({
      headers: {
        'content-type': 'application/json',
        'connection': 'keep-alive',
        'expect': '100-continue',
        'x-antseed-provider': 'anthropic',
        'x-antseed-service': 'claude-sonnet-4-20250514',
        'host': 'localhost:3000',
        'x-custom': 'keep-me',
      },
    }));

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders['connection']).toBeUndefined();
    expect(sentHeaders['expect']).toBeUndefined();
    expect(sentHeaders['x-antseed-provider']).toBeUndefined();
    expect(sentHeaders['x-antseed-service']).toBeUndefined();
    expect(sentHeaders['host']).toBeUndefined();
    expect(sentHeaders['x-custom']).toBe('keep-me');
  });

  it('uses tokenProvider when present', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const tokenProvider = {
      getToken: vi.fn().mockResolvedValue('fresh-token'),
      stop: vi.fn(),
    };

    const relay = new HttpRelay(
      makeConfig({
        authHeaderName: 'authorization',
        authHeaderValue: 'Bearer old-token',
        tokenProvider,
      }),
      callbacks,
    );

    await relay.handleRequest(makeRequest());

    expect(tokenProvider.getToken).toHaveBeenCalledOnce();
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders['authorization']).toBe('Bearer fresh-token');
  });

  it('returns 502 on fetch failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('Connection refused'));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(502);
    const body = JSON.parse(new TextDecoder().decode(responses[0]!.body)) as { error: string };
    expect(body.error).toContain('Connection refused');
  });

  it('forwards SSE as response-start plus chunks', async () => {
    const sseChunks = [
      'event: message\ndata: {"text":"Hello"}\n\n',
      'event: message\ndata: {"text":"World"}\n\n',
    ];
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of sseChunks) {
          controller.enqueue(new TextEncoder().encode(chunk));
        }
        controller.close();
      },
    });

    fetchMock.mockResolvedValueOnce(new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    }));

    const responses: SerializedHttpResponse[] = [];
    const responseChunks: SerializedHttpResponseChunk[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
      onResponseChunk: (chunk) => responseChunks.push(chunk),
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    await relay.handleRequest(makeRequest());

    expect(responses).toHaveLength(1);
    expect(responses[0]!.statusCode).toBe(200);
    expect(responses[0]!.headers['x-antseed-streaming']).toBe('1');
    expect(responses[0]!.body.length).toBe(0);

    expect(responseChunks).toHaveLength(3);
    expect(responseChunks[0]!.done).toBe(false);
    expect(responseChunks[1]!.done).toBe(false);
    expect(responseChunks[2]!.done).toBe(true);

    const bodyText = new TextDecoder().decode(Buffer.concat(
      responseChunks
        .filter((chunk) => chunk.data.length > 0)
        .map((chunk) => Buffer.from(chunk.data))
    ));
    expect(bodyText).toContain('Hello');
    expect(bodyText).toContain('World');
  });

  it('allows GET requests through service validation', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ object: 'list', data: [] }), { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(makeConfig({ allowedServices: ['claude-sonnet-4-20250514'] }), callbacks);
    await relay.handleRequest(makeRequest({
      method: 'GET',
      path: '/v1/models',
      body: new Uint8Array(0),
    }));

    expect(responses[0]!.statusCode).toBe(200);
  });

  it('accepts upstream (full) service names via serviceRewriteMap', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = {
      onResponse: (res) => responses.push(res),
    };

    const relay = new HttpRelay(
      makeConfig({
        allowedServices: ['kimi-k2.5'],
        serviceRewriteMap: { 'kimi-k2.5': 'moonshotai/kimi-k2.5' },
      }),
      callbacks,
    );

    // Buyer sends the full upstream name — should still be accepted
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'moonshotai/kimi-k2.5', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses[0]!.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Body should pass through unchanged (no rewrite entry for the full name)
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as { model?: string };
    expect(parsed.model).toBe('moonshotai/kimi-k2.5');
  });

  it('accepts service names case-insensitively', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = { onResponse: (res) => responses.push(res) };

    // Provider configured with mixed-case service names (as they appear in upstream APIs)
    const relay = new HttpRelay(
      makeConfig({ allowedServices: ['DeepSeek-R1', 'Kimi-K2.5'] }),
      callbacks,
    );

    // Buyer sends lowercase (DHT topics are normalized to lowercase)
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'deepseek-r1', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses[0]!.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('normalizes body.service to body.model for upstream API compatibility', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = { onResponse: (res) => responses.push(res) };

    const relay = new HttpRelay(makeConfig({ allowedServices: ['claude-sonnet-4-20250514'] }), callbacks);
    // Client sends "service" instead of "model"
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ service: 'claude-sonnet-4-20250514', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses[0]!.statusCode).toBe(200);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as Record<string, unknown>;
    // "service" should be removed, "model" should be set
    expect(parsed.model).toBe('claude-sonnet-4-20250514');
    expect(parsed.service).toBeUndefined();
  });

  describe('stream_options.include_usage injection (chat-completions streaming)', () => {
    function chatCompletionsRequest(body: Record<string, unknown>): SerializedHttpRequest {
      return makeRequest({
        path: '/v1/chat/completions',
        body: new TextEncoder().encode(JSON.stringify(body)),
      });
    }

    function relayWith(allowedServices: string[] = ['minimax-m2.7-highspeed']) {
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(
        makeConfig({ allowedServices }),
        { onResponse: (r) => responses.push(r) },
      );
      return { relay, responses };
    }

    function upstreamBody(): Record<string, unknown> {
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      return JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as Record<string, unknown>;
    }

    it('injects include_usage=true on streaming chat-completions requests', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay, responses } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }));
      expect(responses[0]!.statusCode).toBe(200);
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it('preserves caller-supplied stream_options fields', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_obfuscation: false },
      }));
      expect(upstreamBody().stream_options).toEqual({ include_obfuscation: false, include_usage: true });
    });

    it('asks for usage even when the caller sets include_usage:false', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: false, include_obfuscation: false },
      }));
      expect(upstreamBody().stream_options).toEqual({ include_usage: true, include_obfuscation: false });
    });

    it.each([
      ['a dot segment', '/v1/./chat/completions'],
      ['a parent segment', '/x/../v1/chat/completions'],
      ['an encoded dot segment', '/v1/%2e/chat/completions'],
      ['backslashes', '/v1\\chat\\completions'],
      ['no leading slash', 'v1/chat/completions'],
    ])('asks for usage on a chat path written with %s, and sends the path it decided by', async (_shape, path) => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(makeRequest({
        path,
        body: new TextEncoder().encode(JSON.stringify({
          model: 'minimax-m2.7-highspeed',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })),
      }));
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/v1/chat/completions');
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it.each([
      ['no version prefix', '/chat/completions'],
      ['a deployment prefix', '/openai/deployments/d1/chat/completions'],
      ['legacy completions', '/v1/completions'],
      ['a trailing slash', '/v1/chat/completions/'],
      ['a leading double slash', '//v1/chat/completions'],
    ])('asks for usage on a completions path with %s', async (_shape, path) => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(makeRequest({
        path,
        body: new TextEncoder().encode(JSON.stringify({ model: 'minimax-m2.7-highspeed', stream: true })),
      }));
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://api.example.com${path}`);
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it('judges the path alone, not a query string that names a completions path', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(makeRequest({
        path: '/v1/messages?next=/chat/completions',
        body: new TextEncoder().encode(JSON.stringify({ model: 'minimax-m2.7-highspeed', messages: [], stream: true })),
      }));
      expect(upstreamBody().stream_options).toBeUndefined();
    });

    it('keeps the query string of a chat path it normalizes', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(makeRequest({
        path: '/v1/./chat/completions?beta=true',
        body: new TextEncoder().encode(JSON.stringify({ model: 'minimax-m2.7-highspeed', messages: [], stream: true })),
      }));
      const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://api.example.com/v1/chat/completions?beta=true');
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it('asks for usage when stream is truthy but not the literal true, as lenient upstreams accept', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: 1,
      }));
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it('leaves non-streaming chat-completions requests untouched', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
      }));
      expect(upstreamBody().stream_options).toBeUndefined();
    });

    it('leaves non-chat-completions paths untouched (e.g. /v1/responses)', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(
        makeConfig({ allowedServices: ['gpt-5.4'] }),
        { onResponse: (r) => responses.push(r) },
      );
      await relay.handleRequest(makeRequest({
        path: '/v1/responses',
        body: new TextEncoder().encode(JSON.stringify({ model: 'gpt-5.4', input: 'hi', stream: true })),
      }));
      expect(upstreamBody().stream_options).toBeUndefined();
    });

    it('leaves Anthropic /v1/messages requests untouched even with stream:true', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(
        makeConfig({ allowedServices: ['claude-sonnet-4-20250514'] }),
        { onResponse: (r) => responses.push(r) },
      );
      await relay.handleRequest(makeRequest({
        path: '/v1/messages',
        body: new TextEncoder().encode(JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          messages: [{ role: 'user', content: 'hi' }],
          stream: true,
        })),
      }));
      const body = upstreamBody();
      // Anthropic /v1/messages does not understand stream_options.
      expect(body.stream_options).toBeUndefined();
    });

    it('is a no-op when the protocol transform already injected include_usage:true', async () => {
      // Simulates traffic from the Anthropic→Chat or Responses→Chat transform:
      // the request reaches the relay with path=/v1/chat/completions and
      // stream_options.include_usage already set to true.
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: true },
      }));
      // Body unchanged — we do not duplicate or mutate when the option is
      // already correctly set by an upstream transform.
      expect(upstreamBody().stream_options).toEqual({ include_usage: true });
    });

    it('still defers to operator injectJsonFields override', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      // Operator can still force their own value via OPENAI_BODY_INJECT_JSON.
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(
        makeConfig({
          allowedServices: ['minimax-m2.7-highspeed'],
          injectJsonFields: { stream_options: { include_usage: false, include_obfuscation: true } },
        }),
        { onResponse: (r) => responses.push(r) },
      );
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
      }));
      // injectJsonFields runs after our default injection and deep-merges,
      // so an explicit operator override of include_usage wins.
      expect(upstreamBody().stream_options).toEqual({ include_usage: false, include_obfuscation: true });
    });
  });

  describe('defaultHeaders', () => {
    async function sentHeaders(headers: Record<string, string>, config?: Partial<RelayConfig>): Promise<Record<string, string>> {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const relay = new HttpRelay(
        makeConfig({ defaultHeaders: { 'anthropic-version': '2023-06-01' }, ...config }),
        { onResponse: () => undefined },
      );
      await relay.handleRequest(makeRequest({ headers: { 'content-type': 'application/json', ...headers } }));
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      return opts.headers as Record<string, string>;
    }

    it('adds a header the request does not carry', async () => {
      expect((await sentHeaders({}))['anthropic-version']).toBe('2023-06-01');
    });

    it('keeps the header the request carries, whatever its case', async () => {
      const headers = await sentHeaders({ 'Anthropic-Version': '2026-10-21' });
      expect(headers['Anthropic-Version']).toBe('2026-10-21');
      expect(headers['anthropic-version']).toBeUndefined();
    });

    it('replaces a blank header', async () => {
      const headers = await sentHeaders({ 'Anthropic-Version': ' ' });
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(headers['Anthropic-Version']).toBeUndefined();
    });

    it('does not override a header the seller forces', async () => {
      const headers = await sentHeaders({}, { extraHeaders: { 'anthropic-version': '2024-01-01' } });
      expect(headers['anthropic-version']).toBe('2024-01-01');
    });
  });

  describe('omitJsonFields', () => {
    const seen: Array<{ path: string; model: string | undefined }> = [];
    const omitTemperatureForUpstreamB = (request: { path: string; model: string | undefined }) => {
      seen.push(request);
      return request.model === 'upstream-b' ? ['temperature', 'top_k'] : [];
    };

    async function sentBody(
      body: Record<string, unknown>,
      config?: Partial<RelayConfig>,
      request?: Partial<SerializedHttpRequest>,
    ): Promise<Record<string, unknown>> {
      seen.length = 0;
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const relay = new HttpRelay(
        makeConfig({ allowedServices: [], omitJsonFields: omitTemperatureForUpstreamB, ...config }),
        { onResponse: () => undefined },
      );
      await relay.handleRequest(makeRequest({ body: new TextEncoder().encode(JSON.stringify(body)), ...request }));
      const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
      return JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as Record<string, unknown>;
    }

    it('drops the named fields and keeps the rest', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const body = await sentBody({ model: 'upstream-b', temperature: 0.2, top_p: 0.9, max_tokens: 8 });
        expect(body).toEqual({ model: 'upstream-b', top_p: 0.9, max_tokens: 8 });
        // Only the field that was there is reported.
        expect(warn).toHaveBeenCalledTimes(1);
        expect(String(warn.mock.calls[0]![0])).toContain('dropped temperature (');
      } finally {
        warn.mockRestore();
      }
    });

    it('leaves a model it names nothing for untouched, without a log line', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        expect(await sentBody({ model: 'upstream-a', temperature: 0.2 })).toEqual({ model: 'upstream-a', temperature: 0.2 });
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it('judges the model the upstream will see, and the path without its query', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const body = await sentBody(
          { model: 'announced', temperature: 0.2 },
          { allowedServices: ['announced'], serviceRewriteMap: { announced: 'upstream-b' } },
          { path: '/v1/messages?beta=true' },
        );
        expect(body).toEqual({ model: 'upstream-b' });
        expect(seen).toEqual([{ path: '/v1/messages', model: 'upstream-b' }]);
      } finally {
        warn.mockRestore();
      }
    });

    it('logs a dropped field once per model', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
        const relay = new HttpRelay(
          makeConfig({ allowedServices: [], omitJsonFields: omitTemperatureForUpstreamB }),
          { onResponse: () => undefined },
        );
        const body = new TextEncoder().encode(JSON.stringify({ model: 'upstream-b', temperature: 0 }));
        await relay.handleRequest(makeRequest({ requestId: 'a', body }));
        await relay.handleRequest(makeRequest({ requestId: 'b', body }));
        expect(warn).toHaveBeenCalledTimes(1);
      } finally {
        warn.mockRestore();
      }
    });

    it('quotes the model in the log line and stops logging after 100 models', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));
        const relay = new HttpRelay(
          makeConfig({ allowedServices: [], omitJsonFields: () => ['temperature'] }),
          { onResponse: () => undefined },
        );
        for (let i = 0; i < 105; i += 1) {
          const body = new TextEncoder().encode(JSON.stringify({ model: `m${i}\nfake log line`, temperature: 0 }));
          await relay.handleRequest(makeRequest({ requestId: `r${i}`, body }));
        }
        expect(warn).toHaveBeenCalledTimes(100);
        expect(String(warn.mock.calls[0]?.[0])).not.toContain('\n');
      } finally {
        warn.mockRestore();
      }
    });

    it('runs before injectJsonFields, so an operator can still set a field', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        const body = await sentBody(
          { model: 'upstream-b', temperature: 0.2 },
          { injectJsonFields: { temperature: 1 } },
        );
        expect(body).toEqual({ model: 'upstream-b', temperature: 1 });
      } finally {
        warn.mockRestore();
      }
    });
  });

  it('strips body.service when body.model is already present', async () => {
    fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

    const responses: SerializedHttpResponse[] = [];
    const callbacks: RelayCallbacks = { onResponse: (res) => responses.push(res) };

    const relay = new HttpRelay(makeConfig({ allowedServices: ['claude-sonnet-4-20250514'] }), callbacks);
    // Client sends both "service" and "model"
    const req = makeRequest({
      body: new TextEncoder().encode(JSON.stringify({ model: 'claude-sonnet-4-20250514', service: 'claude-sonnet-4-20250514', messages: [] })),
    });
    await relay.handleRequest(req);

    expect(responses[0]!.statusCode).toBe(200);
    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsed = JSON.parse(new TextDecoder().decode(opts.body as Uint8Array)) as Record<string, unknown>;
    expect(parsed.model).toBe('claude-sonnet-4-20250514');
    expect(parsed.service).toBeUndefined();
  });

  it('tracks active count correctly', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 200 }));

    const callbacks: RelayCallbacks = {
      onResponse: () => {},
    };

    const relay = new HttpRelay(makeConfig(), callbacks);
    expect(relay.getActiveCount()).toBe(0);

    await relay.handleRequest(makeRequest());
    expect(relay.getActiveCount()).toBe(0); // decremented after completion
  });

  describe('fallback upstreams', () => {
    const kimiConfig = (overrides?: Partial<RelayConfig>) => makeConfig({
      baseUrl: 'https://primary.example.com',
      authHeaderName: 'authorization',
      authHeaderValue: 'Bearer primary-key',
      allowedServices: ['kimi-k3.1-pro', 'glm-5'],
      fallbackUpstreams: [{ baseUrl: 'https://backup.example.com', authHeaderValue: 'Bearer backup-key' }],
      ...overrides,
    });
    const kimiRequest = (overrides?: Partial<SerializedHttpRequest>) => makeRequest({
      path: '/v1/chat/completions',
      body: new TextEncoder().encode(JSON.stringify({ model: 'kimi-k3.1-pro', messages: [] })),
      ...overrides,
    });
    const ok = () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    const fail = (status: number, headers?: Record<string, string>) => new Response(JSON.stringify({ error: { code: 'exceeded_current_quota_error' } }), {
      status,
      headers: { 'content-type': 'application/json', ...headers },
    });
    const calls = () => fetchMock.mock.calls.map(([url, opts]) => ({
      url: url as string,
      auth: ((opts as RequestInit).headers as Record<string, string>)['authorization'],
      model: JSON.parse(Buffer.from((opts as RequestInit).body as Buffer).toString()).model as string,
    }));
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
      warn.mockRestore();
      vi.useRealTimers();
    });

    it('serves from the next upstream when the primary is out of quota', async () => {
      fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig(), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest());

      expect(responses).toHaveLength(1);
      expect(responses[0]!.statusCode).toBe(200);
      expect(calls()).toEqual([
        { url: 'https://primary.example.com/v1/chat/completions', auth: 'Bearer primary-key', model: 'kimi-k3.1-pro' },
        { url: 'https://backup.example.com/v1/chat/completions', auth: 'Bearer backup-key', model: 'kimi-k3.1-pro' },
      ]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('kimi-k3.1-pro: primary upstream primary.example.com failed (HTTP 429); trying fallback backup.example.com'));
      expect(relay.getActiveCount()).toBe(0);
    });

    it('fails over on network errors', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET')).mockResolvedValueOnce(ok());
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig(), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest());

      expect(responses.map((res) => res.statusCode)).toEqual([200]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns buyer request errors without failing over', async () => {
      fetchMock.mockResolvedValueOnce(fail(400));
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig(), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest());

      expect(responses.map((res) => res.statusCode)).toEqual([400]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns the last upstream response when every upstream fails', async () => {
      fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(fail(503));
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig(), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest());

      expect(responses.map((res) => res.statusCode)).toEqual([503]);
    });

    it('uses the fallback model name and the primary key when the fallback has none', async () => {
      fetchMock.mockResolvedValueOnce(fail(404)).mockResolvedValueOnce(ok());
      const relay = new HttpRelay(kimiConfig({
        serviceRewriteMap: { 'kimi-k3.1-pro': 'kimi-k3.1-pro-2026' },
        fallbackUpstreams: [{ baseUrl: 'https://openrouter.example.com/api', serviceRewriteMap: { 'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro' } }],
      }), { onResponse: () => undefined });

      await relay.handleRequest(kimiRequest());

      expect(calls()).toEqual([
        { url: 'https://primary.example.com/v1/chat/completions', auth: 'Bearer primary-key', model: 'kimi-k3.1-pro-2026' },
        { url: 'https://openrouter.example.com/api/v1/chat/completions', auth: 'Bearer primary-key', model: 'moonshotai/kimi-k3.1-pro' },
      ]);
    });

    it('lets a fallback send the advertised service id when the primary renames it', async () => {
      fetchMock.mockResolvedValueOnce(fail(429)).mockResolvedValueOnce(ok());
      const relay = new HttpRelay(kimiConfig({
        serviceRewriteMap: { 'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro' },
        fallbackUpstreams: [{ baseUrl: 'https://backup.example.com', serviceRewriteMap: { 'kimi-k3.1-pro': 'kimi-k3.1-pro' } }],
      }), { onResponse: () => undefined });

      await relay.handleRequest(kimiRequest());

      expect(calls().map((call) => call.model)).toEqual(['moonshotai/kimi-k3.1-pro', 'kimi-k3.1-pro']);
    });

    it('fails over when a complete response body breaks before delivery', async () => {
      const broken = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"id":'));
          controller.error(new Error('ECONNRESET'));
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
      fetchMock.mockResolvedValueOnce(broken).mockResolvedValueOnce(ok());
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig(), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest());

      expect(responses).toHaveLength(1);
      expect(responses[0]!.statusCode).toBe(200);
      expect(JSON.parse(new TextDecoder().decode(responses[0]!.body))).toEqual({ ok: true });
      expect(calls().map((call) => new URL(call.url).host)).toEqual(['primary.example.com', 'backup.example.com']);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('primary upstream primary.example.com failed (ECONNRESET)'));
    });

    it('never switches upstreams once a stream has started', async () => {
      const broken = new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'));
          controller.error(new Error('ECONNRESET'));
        },
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
      fetchMock.mockResolvedValueOnce(broken).mockResolvedValueOnce(ok());
      const responses: SerializedHttpResponse[] = [];
      const chunks: SerializedHttpResponseChunk[] = [];
      const relay = new HttpRelay(kimiConfig(), {
        onResponse: (res) => responses.push(res),
        onResponseChunk: (chunk) => chunks.push(chunk),
      });

      await relay.handleRequest(kimiRequest());

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(responses.map((res) => res.statusCode)).toEqual([200]);
      expect(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('')).toContain('event: error');
      expect(chunks.at(-1)!.done).toBe(true);
    });

    it('ends a stream cut mid-line or mid-event with an error event of its own', async () => {
      for (const [streamed, closing] of [['data: {"choices":[{"delta":{"content":"Se', '\n\n'], ['data: {"partial":true}\n', '\n'], ['data: {"partial":true}\n\n', '']] as const) {
        fetchMock.mockReset();
        fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(streamed));
          },
          // The cut comes on the next read, after the bytes above were delivered.
          pull(controller) {
            controller.error(new Error('ECONNRESET'));
          },
        }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
        const chunks: SerializedHttpResponseChunk[] = [];
        const relay = new HttpRelay(kimiConfig(), { onResponse: () => {}, onResponseChunk: (chunk) => chunks.push(chunk) });

        await relay.handleRequest(kimiRequest());

        expect(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('')).toBe(`${streamed}${closing}event: error\ndata: ECONNRESET\n\n`);
      }
    });

    it('only uses a fallback for the services it lists', async () => {
      fetchMock.mockResolvedValue(fail(429));
      const responses: SerializedHttpResponse[] = [];
      const relay = new HttpRelay(kimiConfig({
        fallbackUpstreams: [{ baseUrl: 'https://backup.example.com', services: ['kimi-k3.1-pro'] }],
      }), { onResponse: (res) => responses.push(res) });

      await relay.handleRequest(kimiRequest({
        body: new TextEncoder().encode(JSON.stringify({ model: 'glm-5', messages: [] })),
      }));

      expect(responses.map((res) => res.statusCode)).toEqual([429]);
      expect(calls().map((call) => call.url)).toEqual(['https://primary.example.com/v1/chat/completions']);
    });

    it('tries a failed upstream last until its cooldown ends, per service', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      fetchMock.mockImplementation(async (url: string) => (url.startsWith('https://primary') ? fail(429, { 'retry-after': '60' }) : ok()));
      const relay = new HttpRelay(kimiConfig(), { onResponse: () => undefined });

      await relay.handleRequest(kimiRequest());
      await relay.handleRequest(kimiRequest());
      await relay.handleRequest(kimiRequest({
        body: new TextEncoder().encode(JSON.stringify({ model: 'glm-5', messages: [] })),
      }));
      vi.advanceTimersByTime(61_000);
      await relay.handleRequest(kimiRequest());

      expect(calls().map((call) => `${new URL(call.url).host} ${call.model}`)).toEqual([
        'primary.example.com kimi-k3.1-pro',
        'backup.example.com kimi-k3.1-pro',
        // Cooling down: the backup is tried first.
        'backup.example.com kimi-k3.1-pro',
        // Another service still starts at the primary.
        'primary.example.com glm-5',
        'backup.example.com glm-5',
        // Cooldown over: the primary is tried first again.
        'primary.example.com kimi-k3.1-pro',
        'backup.example.com kimi-k3.1-pro',
      ]);
    });

    it('fails over before streaming starts and streams from the fallback', async () => {
      fetchMock.mockResolvedValueOnce(fail(502)).mockResolvedValueOnce(new Response('data: {"ok":true}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
      const responses: SerializedHttpResponse[] = [];
      const chunks: SerializedHttpResponseChunk[] = [];
      const relay = new HttpRelay(kimiConfig(), {
        onResponse: (res) => responses.push(res),
        onResponseChunk: (chunk) => chunks.push(chunk),
      });

      await relay.handleRequest(kimiRequest());

      expect(responses.map((res) => res.statusCode)).toEqual([200]);
      expect(responses[0]!.headers['x-antseed-streaming']).toBe('1');
      expect(new TextDecoder().decode(chunks[0]!.data)).toBe('data: {"ok":true}\n\n');
      expect(chunks.at(-1)!.done).toBe(true);
    });

    it('fails over when the primary token provider cannot produce a token', async () => {
      fetchMock.mockResolvedValueOnce(ok());
      const relay = new HttpRelay(kimiConfig({
        tokenProvider: { getToken: async () => { throw new Error('refresh failed'); } } as unknown as RelayConfig['tokenProvider'],
      }), { onResponse: () => undefined });

      await relay.handleRequest(kimiRequest());

      expect(calls()).toEqual([
        { url: 'https://backup.example.com/v1/chat/completions', auth: 'Bearer backup-key', model: 'kimi-k3.1-pro' },
      ]);
    });
  });
});

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
        'x-antseed-provider': 'anthropic',
        'x-antseed-service': 'claude-sonnet-4-20250514',
        'host': 'localhost:3000',
        'x-custom': 'keep-me',
      },
    }));

    const [, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentHeaders = opts.headers as Record<string, string>;
    expect(sentHeaders['connection']).toBeUndefined();
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

    it('does not override an explicit include_usage:false (operator escape hatch)', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));
      const { relay } = relayWith();
      await relay.handleRequest(chatCompletionsRequest({
        model: 'minimax-m2.7-highspeed',
        messages: [{ role: 'user', content: 'hi' }],
        stream: true,
        stream_options: { include_usage: false },
      }));
      expect(upstreamBody().stream_options).toEqual({ include_usage: false });
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
});

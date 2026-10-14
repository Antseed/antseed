import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import plugin, {
  decodeJwtPayload,
  getJwtExpiration,
  isAuthExpiringSoon,
  readAuthContext,
  refreshAuthContext,
} from './index.js';

const originalFetch = globalThis.fetch;

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode(payload)}.sig`;
}

function writeAuthFile(contents: Record<string, unknown>): string {
  const dir = join(tmpdir(), `antseed-openai-responses-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'auth.json');
  writeFileSync(path, JSON.stringify(contents), 'utf8');
  return path;
}

function readAuthFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

describe('provider-openai-responses plugin', () => {
  it('has correct metadata', () => {
    expect(plugin.name).toBe('openai-responses');
    expect(plugin.displayName).toBe('OpenAI Responses');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('advertises openai-responses protocol', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });
    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });
    expect(provider.serviceApiProtocols?.['gpt-5-codex']).toEqual(['openai-responses']);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('defaults to higher seller concurrency for bursty clients', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });
    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    expect(provider.maxConcurrency).toBe(50);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('reads account id from JWT claim when available', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });

    expect(readAuthContext(authFile)).toEqual({
      accessToken: expect.any(String),
      accountId: 'acct-jwt',
    });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('falls back to account_id from auth file', () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({ sub: 'user-1' }),
        account_id: 'acct-file',
      },
    });

    expect(readAuthContext(authFile).accountId).toBe('acct-file');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('decodes JWT payloads', () => {
    const token = makeJwt({ sub: 'abc', exp: 123 });
    expect(decodeJwtPayload(token)).toEqual({ sub: 'abc', exp: 123 });
    expect(getJwtExpiration(token)).toBe(123000);
  });

  it('detects expiring auth contexts', () => {
    expect(isAuthExpiringSoon({
      accessToken: 'token',
      accountId: 'acct',
      expiresAt: Date.now() + 1000,
    })).toBe(true);
  });

  it('returns 404 for unsupported paths like /v1/models', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex,o4-mini',
    });

    const response = await provider.handleRequest({
      requestId: 'req-models',
      method: 'GET',
      path: '/v1/models',
      headers: {},
      body: new Uint8Array(0),
    });

    expect(response.statusCode).toBe(404);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('relays /v1/responses to Codex backend with required headers', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({
          'https://api.openai.com/auth': {
            chatgpt_account_id: 'acct-jwt',
          },
        }),
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://chatgpt.com/backend-api/codex/responses');
    expect((init.headers as Record<string, string>)['authorization']).toMatch(/^Bearer /);
    expect((init.headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-jwt');
    expect((init.headers as Record<string, string>)['openai-beta']).toBe('responses=experimental');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('preserves an explicit reasoning profile when relaying to the Codex backend', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.6-sol',
    });

    await provider.handleRequest({
      requestId: 'req-reasoning-profile',
      method: 'POST',
      path: '/v1/responses',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.6-sol',
        input: 'Return only 42',
        reasoning: { effort: 'none' },
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(
      new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0)),
    ) as Record<string, unknown>;
    expect(upstreamBody.reasoning).toEqual({ effort: 'none' });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('rewrites announced service names via alias map', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'codex',
      ANTSEED_SERVICE_ALIAS_MAP_JSON: '{"codex":"gpt-5-codex"}',
    });

    await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'codex',
        input: 'hello',
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as { model: string };
    expect(body.model).toBe('gpt-5-codex');
    expect(body.store).toBe(false);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('preserves an explicit store value from the caller', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    await provider.handleRequest({
      requestId: 'req-store',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        store: true,
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as { store: boolean };
    expect(body.store).toBe(true);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('strips unsupported fields before relaying to the upstream backend', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });

    await provider.handleRequest({
      requestId: 'req-metadata',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello',
        metadata: { trace: 'abc' },
        user: 'user-123',
        temperature: 0.2,
        top_p: 0.9,
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.metadata).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('forces upstream streaming and collapses SSE for non-stream callers', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        'event: response.created\n'
          + 'data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_1","model":"gpt-5.5","status":"in_progress","output":[]}}\n\n'
          + 'event: response.output_item.added\n'
          + 'data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}\n\n'
          + 'event: response.content_part.added\n'
          + 'data: {"type":"response.content_part.added","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"","annotations":[]}}\n\n'
          + 'event: response.output_text.delta\n'
          + 'data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"h","logprobs":[]}\n\n'
          + 'event: response.output_text.delta\n'
          + 'data: {"type":"response.output_text.delta","sequence_number":4,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"i","logprobs":[]}\n\n'
          + 'event: response.output_text.done\n'
          + 'data: {"type":"response.output_text.done","sequence_number":5,"item_id":"msg_1","output_index":0,"content_index":0,"text":"hi","logprobs":[]}\n\n'
          + 'event: response.content_part.done\n'
          + 'data: {"type":"response.content_part.done","sequence_number":6,"item_id":"msg_1","output_index":0,"content_index":0,"part":{"type":"output_text","text":"hi","annotations":[]}}\n\n'
          + 'event: response.output_item.done\n'
          + 'data: {"type":"response.output_item.done","sequence_number":7,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi","annotations":[]}]}}\n\n'
          + 'event: response.completed\n'
          + 'data: {"type":"response.completed","sequence_number":8,"response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"completed","output":[],"usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n'
          + 'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });

    const response = await provider.handleRequest({
      requestId: 'req-stream-required',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello',
        stream: false,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamBody = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as Record<string, unknown>;
    expect(upstreamBody.stream).toBe(true);
    expect(response.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(body.id).toBe('resp_1');
    expect(body.output).toEqual([{
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hi', annotations: [] }],
    }]);
    expect(body.output_text).toBeUndefined();
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('does not stream callbacks when forced streaming serves a non-stream request', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        'event: response.completed\n'
          + 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-5.5","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hi","annotations":[]}]}],"output_text":"hi","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n'
          + 'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });
    const callbacks = {
      onResponseStart: vi.fn(),
      onResponseChunk: vi.fn(),
    };

    const response = await provider.handleRequestStream!({
      requestId: 'req-forced-stream-callbacks',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello',
        stream: false,
      })),
    }, callbacks);

    expect(callbacks.onResponseStart).not.toHaveBeenCalled();
    expect(callbacks.onResponseChunk).not.toHaveBeenCalled();
    expect(response.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(body.output_text).toBe('hi');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('collapses SSE for transformed non-stream callers when stream is already true', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        'event: response.completed\n'
          + 'data: {"type":"response.completed","response":{"id":"resp_2","object":"response","model":"gpt-5.5","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"hello","annotations":[]}]}],"output_text":"hello","usage":{"input_tokens":3,"output_tokens":1,"total_tokens":4}}}\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });

    const response = await provider.handleRequest({
      requestId: 'req-transformed-non-stream',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
        'x-antseed-client-stream-requested': 'false',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello',
        stream: true,
      })),
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const upstreamHeaders = init.headers as Record<string, string>;
    const upstreamBody = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as Record<string, unknown>;
    expect(upstreamBody.stream).toBe(true);
    expect(upstreamHeaders['x-antseed-client-stream-requested']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(body.id).toBe('resp_2');
    expect(body.output_text).toBe('hello');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('collapses failed Responses SSE into a JSON error for non-stream callers', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        'event: response.failed\n'
          + 'data: {"type":"response.failed","response":{"id":"resp_1","status":"failed","error":{"type":"server_error","message":"backend failed"}}}\n\n'
          + 'data: [DONE]\n\n',
        {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        },
      ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });

    const response = await provider.handleRequest({
      requestId: 'req-failed-stream',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(502);
    expect(response.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    expect(body).toEqual({
      error: {
        type: 'server_error',
        message: 'backend failed',
      },
    });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('does not add create-only fields to Responses subresources', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5.5',
    });

    await provider.handleRequest({
      requestId: 'req-cancel',
      method: 'POST',
      path: '/v1/responses/resp_1/cancel',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({})),
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/responses\/resp_1\/cancel$/);
    const body = JSON.parse(new TextDecoder().decode((init.body as Uint8Array) ?? new Uint8Array(0))) as Record<string, unknown>;
    expect(body).toEqual({});
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('retries transient upstream failures', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('slow down', { status: 429, headers: { 'content-type': 'text/plain' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes tokens and persists auth.json when expired', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const refreshed = await refreshAuthContext(authFile);

    expect(refreshed.accountId).toBe('acct-new');
    expect(refreshed.refreshToken).toBe('refresh-2');
    const saved = readAuthFile(authFile);
    expect((saved.tokens as Record<string, unknown>).access_token).toBe(freshToken);
    expect((saved.tokens as Record<string, unknown>).refresh_token).toBe('refresh-2');
    expect(saved.last_refresh).toEqual(expect.any(String));
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('preserves existing non-token fields when refreshing auth.json', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      OPENAI_API_KEY: 'legacy',
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await refreshAuthContext(authFile);

    const saved = readAuthFile(authFile);
    expect(saved.OPENAI_API_KEY).toBe('legacy');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('times out token refresh requests', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort('timeout'));
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      throw new Error('expected aborted signal');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAuthContext(authFile)).rejects.toThrow('timed out');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes before request when access token is expired', async () => {
    const expiredToken = makeJwt({
      exp: Math.floor((Date.now() - 60_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: expiredToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-expired',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>).toMatchObject({
      'chatgpt-account-id': 'acct-new',
    });
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('refreshes and retries once on 401', async () => {
    const currentToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 7200_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: currentToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-401',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[1]?.[0]).toBe('https://auth.openai.com/oauth/token');
    expect(((fetchMock.mock.calls[2]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-new');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('retries transient failures that happen after a 401 refresh', async () => {
    const currentToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-old',
      },
    });
    const freshToken = makeJwt({
      exp: Math.floor((Date.now() + 7200_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-new',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: currentToken,
        refresh_token: 'refresh-1',
        account_id: 'acct-old',
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('unauthorized', {
        status: 401,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: freshToken,
        refresh_token: 'refresh-2',
        expires_in: 3600,
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response('temporary failure', {
        status: 503,
        headers: { 'content-type': 'text/plain' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const response = await provider.handleRequest({
      requestId: 'req-401-transient',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('caches auth context between non-refreshing requests', async () => {
    const initialToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-initial',
      },
    });
    const changedToken = makeJwt({
      exp: Math.floor((Date.now() + 3600_000) / 1000),
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct-changed',
      },
    });
    const authFile = writeAuthFile({
      tokens: {
        access_token: initialToken,
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'resp_2' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    await provider.handleRequest({
      requestId: 'req-cache-1',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });

    writeFileSync(authFile, JSON.stringify({
      tokens: {
        access_token: changedToken,
      },
    }), 'utf8');

    await provider.handleRequest({
      requestId: 'req-cache-2',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello again',
        stream: false,
      })),
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(((fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-initial');
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).headers as Record<string, string>)['chatgpt-account-id']).toBe('acct-initial');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('streams SSE responses through callbacks and reconstructs the full body', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_1"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const starts: Array<{ statusCode: number }> = [];
    const chunks: SerializedChunk[] = [];
    const response = await provider.handleRequestStream(
      {
        requestId: 'req-stream',
        method: 'POST',
        path: '/v1/responses',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'gpt-5-codex',
          input: 'hello',
          stream: true,
        })),
      },
      {
        onResponseStart: (start) => starts.push({ statusCode: start.statusCode }),
        onResponseChunk: (chunk) => chunks.push({
          done: chunk.done,
          text: new TextDecoder().decode(chunk.data),
        }),
      },
    );

    expect(starts).toEqual([{ statusCode: 200 }]);
    expect(chunks.some((chunk) => chunk.text.includes('response.created'))).toBe(true);
    expect(chunks.at(-1)?.done).toBe(true);
    expect(new TextDecoder().decode(response.body)).toContain('[DONE]');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('does not emit SSE callbacks for retryable attempts', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    const retryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_retry"}\n\n'));
        controller.close();
      },
    });
    const successStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.created\ndata: {"id":"resp_final"}\n\n'));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(retryStream, {
        status: 503,
        headers: { 'content-type': 'text/event-stream' },
      }))
      .mockResolvedValueOnce(new Response(successStream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const starts: Array<{ statusCode: number }> = [];
    const chunks: SerializedChunk[] = [];
    const response = await provider.handleRequestStream(
      {
        requestId: 'req-stream-retry',
        method: 'POST',
        path: '/v1/responses',
        headers: {
          'content-type': 'application/json',
        },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'gpt-5-codex',
          input: 'hello',
          stream: true,
        })),
      },
      {
        onResponseStart: (start) => starts.push({ statusCode: start.statusCode }),
        onResponseChunk: (chunk) => chunks.push({
          done: chunk.done,
          text: new TextDecoder().decode(chunk.data),
        }),
      },
    );

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(starts).toEqual([{ statusCode: 200 }]);
    expect(chunks.some((chunk) => chunk.text.includes('resp_retry'))).toBe(false);
    expect(chunks.some((chunk) => chunk.text.includes('resp_final'))).toBe(true);
    expect(new TextDecoder().decode(response.body)).toContain('resp_final');
    rmSync(dirname(authFile), { recursive: true, force: true });
  });

  it('returns a 502 after upstream timeout retries are exhausted', async () => {
    const authFile = writeAuthFile({
      tokens: {
        access_token: makeJwt({}),
        account_id: 'acct-file',
      },
    });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort('timeout'));
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: TimerHandler) => {
      if (typeof fn === 'function') fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const signal = init?.signal;
      return await new Promise<Response>((_resolve, reject) => {
        if (!signal) {
          reject(new Error('missing signal'));
          return;
        }
        if (signal.aborted) {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
          return;
        }
        const onAbort = () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const provider = plugin.createProvider({
      OPENAI_RESPONSES_AUTH_FILE: authFile,
      ANTSEED_ALLOWED_SERVICES: 'gpt-5-codex',
    });

    const pendingResponse = provider.handleRequest({
      requestId: 'req-timeout',
      method: 'POST',
      path: '/v1/responses',
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5-codex',
        input: 'hello',
        stream: false,
      })),
    });
    const response = await pendingResponse;

    expect(response.statusCode).toBe(502);
    expect(new TextDecoder().decode(response.body)).toContain('timed out');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    rmSync(dirname(authFile), { recursive: true, force: true });
  });
});

interface SerializedChunk {
  done: boolean;
  text: string;
}

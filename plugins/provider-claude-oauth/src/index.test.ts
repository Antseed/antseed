import { describe, it, expect, vi, afterEach } from 'vitest';
import plugin from './index.js';

describe('provider-claude-oauth plugin manifest', () => {
  it('has correct plugin metadata', () => {
    expect(plugin.name).toBe('claude-oauth');
    expect(plugin.displayName).toBe('Claude (OAuth)');
    expect(plugin.version).toBe('0.1.0');
    expect(plugin.type).toBe('provider');
    expect(plugin.description).toBe('Claude OAuth provider (testing and development only)');
  });

  it('exposes configSchema with required fields', () => {
    expect(plugin.configSchema).toBeDefined();
    const keys = plugin.configSchema!.map(f => f.key);
    expect(keys).toContain('CLAUDE_ACCESS_TOKEN');
    expect(keys).toContain('CLAUDE_REFRESH_TOKEN');
    expect(keys).toContain('CLAUDE_TOKEN_EXPIRES_AT');
    expect(keys).toContain('CLAUDE_OAUTH_CLIENT_ID');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    const accessField = plugin.configSchema!.find(f => f.key === 'CLAUDE_ACCESS_TOKEN');
    expect(keys).toContain('CLAUDE_AUTH_FILE');
    expect(accessField!.required).toBe(false);
    expect(accessField!.type).toBe('secret');
    const clientIdField = plugin.configSchema!.find(f => f.key === 'CLAUDE_OAUTH_CLIENT_ID');
    expect(clientIdField!.required).toBe(false);
    expect(clientIdField!.default).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
  });
});

describe('createProvider', () => {
  it('creates provider with access token only (static)', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
    expect(provider.maxConcurrency).toBe(5);
  });

  it('creates provider with access + refresh token (OAuth)', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_REFRESH_TOKEN: 'test-refresh-token',
      CLAUDE_TOKEN_EXPIRES_AT: String(Date.now() + 3600_000),
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
  });

  it('rejects missing access token', () => {
    expect(() => plugin.createProvider({})).toThrow('CLAUDE_ACCESS_TOKEN is required');
  });

  it('defaults missing client ID to Claude Code client ID', () => {
    const provider = plugin.createProvider({ CLAUDE_ACCESS_TOKEN: 'tok' });
    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
  });

  it('provider has correct name and pricing', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
      ANTSEED_INPUT_USD_PER_MILLION: '15',
      ANTSEED_OUTPUT_USD_PER_MILLION: '30',
      ANTSEED_MAX_CONCURRENCY: '3',
    });
    expect(provider.name).toBe('claude-oauth');
    expect(provider.pricing).toEqual({
      defaults: {
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 30,
      },
    });
    expect(provider.maxConcurrency).toBe(3);
  });

  it('injects anthropic headers at provider relay layer', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_OAUTH_CLIENT_ID: 'test-client-id',
    }) as any;

    const extraHeaders = provider?._relay?._config?.extraHeaders as Record<string, string> | undefined;
    expect(extraHeaders).toBeDefined();
    expect(extraHeaders?.['anthropic-version']).toBe('2023-06-01');
    expect(extraHeaders?.['anthropic-beta']).toBe('claude-code-20250219,oauth-2025-04-20');
    expect(extraHeaders?.['user-agent']).toBe('claude-cli/2.1.75');
    expect(extraHeaders?.['x-app']).toBe('cli');
  });

  it('creates OAuth-backed provider without explicit client ID', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_REFRESH_TOKEN: 'test-refresh-token',
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
    expect(provider.maxConcurrency).toBe(5);
  });

  it('ignores absurd far-future expiry timestamps from external auth stores', () => {
    const provider = plugin.createProvider({
      CLAUDE_ACCESS_TOKEN: 'test-access-token',
      CLAUDE_REFRESH_TOKEN: 'test-refresh-token',
      CLAUDE_TOKEN_EXPIRES_AT: '1808115486904',
    });

    expect(provider).toBeDefined();
    expect(provider.name).toBe('claude-oauth');
  });
});

describe('Claude Code identity system prompt', () => {
  const IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";
  const identityBlock = { type: 'text', text: IDENTITY };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function upstreamSystem(system: unknown, stream = false): Promise<unknown> {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider({ CLAUDE_ACCESS_TOKEN: 'test-access-token' });
    const body: Record<string, unknown> = { model: 'claude-sonnet-4-5', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
    if (system !== undefined) body.system = system;
    const request = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify(body)),
    };
    if (stream) {
      await provider.handleRequestStream!(request, {
        onResponseStart: () => undefined,
        onResponseChunk: () => undefined,
      });
    } else {
      await provider.handleRequest(request);
    }
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    return (JSON.parse(new TextDecoder().decode(options.body as Uint8Array)) as Record<string, unknown>).system;
  }

  it('keeps the buyer system prompt blocks after the identity', async () => {
    const buyerBlocks = [
      { type: 'text', text: 'App instructions', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '<available_skills>antseed-videos</available_skills>' },
    ];
    expect(await upstreamSystem(buyerBlocks)).toEqual([identityBlock, ...buyerBlocks]);
  });

  it('keeps a string system prompt after the identity', async () => {
    expect(await upstreamSystem('Be brief.')).toEqual([identityBlock, { type: 'text', text: 'Be brief.' }]);
  });

  it('adds only the identity when the request has no system prompt', async () => {
    expect(await upstreamSystem(undefined)).toEqual([identityBlock]);
  });

  it('does not duplicate the identity when the request already starts with it', async () => {
    const buyerBlocks = [
      { type: 'text', text: IDENTITY, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'App instructions' },
    ];
    expect(await upstreamSystem(buyerBlocks)).toEqual(buyerBlocks);
  });

  it('leaves image request bodies untouched', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const provider = plugin.createProvider({ CLAUDE_ACCESS_TOKEN: 'test-access-token' });
    await provider.handleRequest({
      requestId: 'req-img',
      method: 'POST',
      path: '/v1/images/generations',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ model: 'img', prompt: 'A seedling' })),
    });
    const [, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(new TextDecoder().decode(options.body as Uint8Array))).toEqual({ model: 'img', prompt: 'A seedling' });
  });

  it('applies to streaming requests', async () => {
    expect(await upstreamSystem([{ type: 'text', text: 'App instructions' }], true)).toEqual([
      identityBlock,
      { type: 'text', text: 'App instructions' },
    ]);
  });
});

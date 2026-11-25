import { describe, it, expect, vi, afterEach } from 'vitest';
import plugin from './index.js';
import { ClaudeCodeTokenProvider } from './claude-code-token.js';

vi.mock('./claude-code-token.js', () => ({
  ClaudeCodeTokenProvider: class {
    async getToken(): Promise<string> { return 'test-token'; }
    async refresh(): Promise<string> { return 'test-token'; }
    getState(): null { return null; }
    stop(): void {}
  },
}));

describe('provider-claude-code plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('claude-code');
    expect(plugin.displayName).toBe('Claude Code');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    expect(keys).toContain('ANTSEED_SERVICE_PRICING_JSON');
    expect(keys).toContain('ANTSEED_SERVICE_ALIAS_MAP_JSON');
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    expect(keys).not.toContain('ANTSEED_AUTH_TYPE');
  });

  it('creates provider with default config', () => {
    // Note: this will fail at runtime without keytar/keychain, but the
    // provider object should be constructed without calling getToken()
    const provider = plugin.createProvider({});
    expect(provider.name).toBe('claude-code');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(10);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(10);
    expect(provider.maxConcurrency).toBe(10);
  });

  describe('upstream request', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    // The keychain is never read: the token comes from the mocked provider.
    async function upstreamRequest(model: string, clientHeaders: Record<string, string> = {}): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
      vi.spyOn(ClaudeCodeTokenProvider.prototype, 'getToken').mockResolvedValue('test-access-token');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await plugin.createProvider({}).handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json', ...clientHeaders },
        body: new TextEncoder().encode(JSON.stringify({ model, temperature: 0.7, top_p: 0.9, top_k: 5 })),
      });
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      return {
        headers: init.headers as Record<string, string>,
        body: JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Record<string, unknown>,
      };
    }

    it('defaults anthropic-version and drops sampling fields the model rejects', async () => {
      const { headers, body } = await upstreamRequest('claude-haiku-5-5');
      expect(headers['anthropic-version']).toBe('2023-06-01');
      expect(body).toEqual({ model: 'claude-haiku-5-5' });
    });

    it("sends the buyer's Claude Code user agent upstream, which Anthropic reads the version from", async () => {
      const { headers } = await upstreamRequest('claude-haiku-4-5', { 'user-agent': 'claude-cli/1.0.0 (external, cli)' });
      expect(headers['user-agent']).toBe('claude-cli/1.0.0 (external, cli)');
    });

    it('keeps sampling fields for a model that accepts them', async () => {
      const { body } = await upstreamRequest('claude-haiku-4-5');
      expect(body).toEqual({ model: 'claude-haiku-4-5', temperature: 0.7, top_p: 0.9, top_k: 5 });
    });
  });

  it('applies custom pricing', () => {
    const provider = plugin.createProvider({
      ANTSEED_INPUT_USD_PER_MILLION: '5',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(5);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(15);
  });

  it('applies per-service pricing', () => {
    const provider = plugin.createProvider({
      ANTSEED_ALLOWED_SERVICES: 'claude-sonnet-4-5',
      ANTSEED_SERVICE_PRICING_JSON: JSON.stringify({
        'claude-sonnet-4-5': {
          inputUsdPerMillion: 3,
          outputUsdPerMillion: 15,
        },
      }),
    });
    expect(provider.pricing.services?.['claude-sonnet-4-5']).toEqual({
      inputUsdPerMillion: 3,
      outputUsdPerMillion: 15,
    });
  });

  it('sends the upstream model of an aliased service', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5-20250929',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 3, output_tokens: 1 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const provider = plugin.createProvider({
        ANTSEED_ALLOWED_SERVICES: 'claude-sonnet',
        ANTSEED_SERVICE_ALIAS_MAP_JSON: JSON.stringify({ 'claude-sonnet': 'claude-sonnet-4-5-20250929' }),
      });
      const response = await provider.handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          model: 'claude-sonnet',
          max_tokens: 16,
          messages: [{ role: 'user', content: 'hi' }],
        })),
      });
      expect(response.statusCode).toBe(200);
      const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
      const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as { model?: string };
      expect(body.model).toBe('claude-sonnet-4-5-20250929');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

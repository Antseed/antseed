import { describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

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

import { describe, it, expect, vi, afterEach } from 'vitest';
import plugin from './index.js';
import { ClaudeCodeTokenProvider } from './claude-code-token.js';

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
    async function upstreamRequest(model: string): Promise<{ headers: Record<string, string>; body: Record<string, unknown> }> {
      vi.spyOn(ClaudeCodeTokenProvider.prototype, 'getToken').mockResolvedValue('test-access-token');
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);
      await plugin.createProvider({}).handleRequest({
        requestId: 'req-1',
        method: 'POST',
        path: '/v1/messages',
        headers: { 'content-type': 'application/json' },
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
});

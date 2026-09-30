import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import plugin from './index.js';

const keytarMock = vi.hoisted(() => ({
  getPassword: vi.fn(),
  findCredentials: vi.fn(),
}));

vi.mock('keytar', () => ({ default: keytarMock }));

describe('provider-claude-code plugin', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock;
    keytarMock.getPassword.mockReset();
    keytarMock.findCredentials.mockReset();
    keytarMock.getPassword.mockResolvedValue(null);
    keytarMock.findCredentials.mockResolvedValue([
      {
        account: 'test-account',
        password: JSON.stringify({
          claudeAiOauth: {
            accessToken: 'access-1',
            refreshToken: 'refresh-1',
            expiresAt: Date.now() + 60 * 60 * 1000,
          },
        }),
      },
    ]);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

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

  it('applies custom pricing', () => {
    const provider = plugin.createProvider({
      ANTSEED_INPUT_USD_PER_MILLION: '5',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
    });
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(5);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(15);
  });

  it('refreshes and retries when Anthropic rejects the current access token', async () => {
    fetchMock.mockImplementation(async (input: string) => {
      if (input === 'https://platform.claude.com/v1/oauth/token') {
        return new Response(JSON.stringify({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: 3600,
        }), { status: 200 });
      }

      const callCount = fetchMock.mock.calls.filter(([url]) => url !== 'https://platform.claude.com/v1/oauth/token').length;
      if (callCount === 1) {
        return new Response('expired', { status: 401 });
      }

      return new Response(JSON.stringify({ id: 'msg-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const provider = plugin.createProvider({});
    const response = await provider.handleRequest({
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        messages: [],
      })),
    });

    expect(response.statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const firstRequest = fetchMock.mock.calls[0] as [string, RequestInit];
    const retryRequest = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((firstRequest[1].headers as Record<string, string>).authorization).toBe('Bearer access-1');
    expect((retryRequest[1].headers as Record<string, string>).authorization).toBe('Bearer access-2');
  });
});

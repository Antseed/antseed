import { describe, it, expect } from 'vitest';
import plugin from './index.js';

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

  it('defaults anthropic-version and drops sampling fields the model rejects', () => {
    // Read from the relay config: sending a request would read the keychain.
    const relay = (plugin.createProvider({}) as any)._relay._config;
    expect(relay.defaultHeaders).toEqual({ 'anthropic-version': '2023-06-01' });
    expect(relay.omitJsonFields({ path: '/v1/messages', model: 'claude-haiku-5-5' })).toEqual(['temperature', 'top_p', 'top_k']);
    expect(relay.omitJsonFields({ path: '/v1/messages', model: 'claude-haiku-4-5' })).toEqual([]);
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

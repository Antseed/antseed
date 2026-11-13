import { describe, it, expect } from 'vitest';
import plugin from './index.js';

describe('provider-local-llm plugin', () => {
  it('has correct name and metadata', () => {
    expect(plugin.name).toBe('local-llm');
    expect(plugin.displayName).toBe('Local LLM');
    expect(plugin.type).toBe('provider');
    expect(plugin.version).toBe('0.1.0');
  });

  it('has configSchema with expected fields', () => {
    const keys = plugin.configSchema!.map((f) => f.key);
    expect(keys).toContain('LOCAL_LLM_BASE_URL');
    expect(keys).toContain('LOCAL_LLM_API_KEY');
    expect(keys).toContain('ANTSEED_INPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_OUTPUT_USD_PER_MILLION');
    expect(keys).toContain('ANTSEED_MAX_CONCURRENCY');
    expect(keys).toContain('ANTSEED_ALLOWED_SERVICES');
    expect(keys).toContain('ANTSEED_SERVICE_PRICING_JSON');
    expect(keys).toContain('ANTSEED_SERVICE_CAPABILITIES_JSON');
  });

  it('creates provider with default config', () => {
    const provider = plugin.createProvider({});
    expect(provider.name).toBe('local-llm');
    expect(provider.pricing.defaults.inputUsdPerMillion).toBe(0);
    expect(provider.pricing.defaults.outputUsdPerMillion).toBe(0);
    expect(provider.maxConcurrency).toBe(1);
  });

  it('creates provider with custom base URL and API key', () => {
    const provider = plugin.createProvider({
      LOCAL_LLM_BASE_URL: 'http://192.168.1.100:8080',
      LOCAL_LLM_API_KEY: 'my-local-key',
    });
    expect(provider.name).toBe('local-llm');
    expect(provider.maxConcurrency).toBe(1);
  });

  it('applies custom concurrency', () => {
    const provider = plugin.createProvider({
      ANTSEED_MAX_CONCURRENCY: '4',
    });
    expect(provider.maxConcurrency).toBe(4);
  });

  it('applies per-service pricing', () => {
    const provider = plugin.createProvider({
      ANTSEED_SERVICE_PRICING_JSON: JSON.stringify({
        'qwen3.5-9b': {
          inputUsdPerMillion: 0.15,
          outputUsdPerMillion: 0.6,
        },
      }),
    });
    expect(provider.pricing.services?.['qwen3.5-9b']).toEqual({
      inputUsdPerMillion: 0.15,
      outputUsdPerMillion: 0.6,
    });
  });

  it('announces configured service capabilities', () => {
    const provider = plugin.createProvider({
      ANTSEED_ALLOWED_SERVICES: 'llama3.2-vision',
      ANTSEED_SERVICE_CAPABILITIES_JSON: JSON.stringify({
        'llama3.2-vision': {
          contextWindow: 131072,
          inputs: ['text', 'image'],
          toolUse: true,
        },
      }),
    });
    expect(provider.serviceCapabilities?.['llama3.2-vision']).toEqual({
      contextWindow: 131072,
      inputs: ['text', 'image'],
      toolUse: true,
    });
  });
});

import type { AntseedProviderPlugin, Provider, ServiceApiProtocol } from '@antseed/node';
import { BaseProvider, StaticTokenProvider, parseServiceAliasMap, parseServiceCapabilitiesJson, parseServicePricingJson } from '@antseed/provider-core';

function parseNonNegativeNumber(raw: string | undefined, key: string, fallback: number): number {
  const parsed = raw === undefined ? fallback : Number.parseFloat(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${key} must be a non-negative number`);
  }
  return parsed;
}

function buildServiceApiProtocols(
  services: string[],
  protocol: ServiceApiProtocol,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  return Object.fromEntries(services.map((service) => [service, [protocol]]));
}

const plugin: AntseedProviderPlugin = {
  name: 'local-llm',
  displayName: 'Local LLM',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide local LLM capacity to P2P peers',
  configSchema: [
    { key: 'LOCAL_LLM_BASE_URL', label: 'Base URL', type: 'string', required: false, default: 'http://localhost:11434', description: 'Local LLM server base URL' },
    { key: 'LOCAL_LLM_API_KEY', label: 'API Key', type: 'secret', required: false, description: 'Optional API key for local LLM' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 0, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 0, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 1, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service → upstream model name' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string', required: false, description: 'Per-service model capability JSON' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const baseUrl = config['LOCAL_LLM_BASE_URL'] ?? 'http://localhost:11434';
    const apiKey = config['LOCAL_LLM_API_KEY'] ?? '';
    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);

    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 0),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 0),
        ...(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) } : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '1', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const allowedServices = config['ANTSEED_ALLOWED_SERVICES']
      ? config['ANTSEED_ALLOWED_SERVICES'].split(',').map((s: string) => s.trim())
      : [];
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'openai-chat-completions');
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);

    const tokenProvider = apiKey ? new StaticTokenProvider(apiKey) : undefined;

    return new BaseProvider({
      name: 'local-llm',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      ...(serviceCapabilities ? { serviceCapabilities } : {}),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: apiKey ? `Bearer ${apiKey}` : '',
        tokenProvider,
        maxConcurrency,
        allowedServices,
        serviceRewriteMap,
      },
    });
  },
};

export default plugin;

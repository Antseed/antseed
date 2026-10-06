import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import {
  BaseProvider,
  StaticTokenProvider,
  buildServiceApiProtocols,
  parseCsv,
  parseNonNegativeNumber,
  parseServiceAliasMap,
  parseServiceCapabilitiesJson,
  parseServicePricingJson,
} from '@antseed/provider-core';

/**
 * System One decision models (TypeSafe Jev) speak `POST /v1/systemone`:
 * a `state` plus typed `questions` in, typed `answers` with probabilities
 * out. Not a chat API, so every service here is advertised as
 * `typesafe-systemone` and buyers route by that protocol.
 */
const plugin: AntseedProviderPlugin = {
  name: 'typesafe',
  displayName: 'TypeSafe',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide System One decision-model capacity (TypeSafe Jev and compatible upstreams)',
  configSchema: [
    { key: 'TYPESAFE_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'TypeSafe (or compatible upstream) API key' },
    { key: 'TYPESAFE_BASE_URL', label: 'Base URL', type: 'string', required: false, default: 'https://api.typesafe.ai', description: 'System One API base URL' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 0.05, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 0, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string', required: false, description: 'Per-service capability JSON (contextWindow, inputs, supportedParameters)' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list (e.g. jev-latest)' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service → upstream model name' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['TYPESAFE_API_KEY']?.trim() ?? '';
    if (!apiKey) {
      throw new Error('TYPESAFE_API_KEY is required');
    }

    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 0.05),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 0),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '10', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const baseUrl = config['TYPESAFE_BASE_URL']?.trim() || 'https://api.typesafe.ai';
    const allowedServices = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    const serviceApiProtocols = buildServiceApiProtocols(allowedServices, 'typesafe-systemone');
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);

    return new BaseProvider({
      name: 'typesafe',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      ...(serviceCapabilities ? { serviceCapabilities } : {}),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        tokenProvider: new StaticTokenProvider(apiKey),
        maxConcurrency,
        allowedServices,
        ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
      },
    });
  },
};

export default plugin;

import type { AntseedProviderPlugin, Provider } from '@antseed/node';
import {
  BaseProvider,
  StaticTokenProvider,
  isImageModelId,
  parseCsv,
  parseFallbackUpstreamsJson,
  parseJsonObject,
  parseNonNegativeNumber,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  parseServiceAliasMap,
  parseServicePricingJson,
} from '@antseed/provider-core';
import type { ServiceApiProtocol, ServiceCapabilities } from '@antseed/node';

const SPECIAL_OPENAI_COMPAT_PROVIDERS = ['openrouter'] as const;
type OpenAiCompatFlavor = 'generic' | (typeof SPECIAL_OPENAI_COMPAT_PROVIDERS)[number];

function parseExtraHeaders(raw: string | undefined): Record<string, string> | undefined {
  const parsed = parseJsonObject(raw, 'OPENAI_EXTRA_HEADERS_JSON');
  if (!parsed) {
    return undefined;
  }

  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    const header = key.trim();
    if (!header) continue;
    if (typeof value === 'string') {
      out[header] = value;
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[header] = String(value);
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function resolveFlavor(configFlavor: string | undefined, baseUrl: string | undefined): OpenAiCompatFlavor {
  const flavor = configFlavor?.trim().toLowerCase();
  if (flavor === 'openrouter') {
    return 'openrouter';
  }

  if (baseUrl) {
    try {
      const host = new URL(baseUrl).hostname.toLowerCase();
      if (host.includes('openrouter.ai')) {
        return 'openrouter';
      }
    } catch {
      if (baseUrl.toLowerCase().includes('openrouter.ai')) {
        return 'openrouter';
      }
    }
  }

  return 'generic';
}

function getAdvertisedServiceProtocol(
  service: string,
  flavor: OpenAiCompatFlavor,
): ServiceApiProtocol | null {
  if (isImageModelId(service)) {
    if (flavor === 'openrouter') {
      return null;
    }
    return 'openai-images';
  }
  return 'openai-chat-completions';
}

function buildOpenAiServiceApiProtocols(
  services: string[],
  flavor: OpenAiCompatFlavor,
  serviceRewriteMap?: Record<string, string>,
): Record<string, ServiceApiProtocol[]> | undefined {
  if (services.length === 0) return undefined;
  const entries = services.flatMap((service) => {
      // Buyers route on the advertised protocol before HttpRelay rewrites the
      // public service ID to the upstream model. Classify from the rewritten
      // target too so aliases like `cover-art -> gpt-image-1` are advertised
      // as images instead of being filtered out as chat-only. OpenRouter image
      // models are skipped here until we add a real Images API adapter for its
      // chat/responses-based upstream shape.
      const upstreamService = serviceRewriteMap?.[service.trim().toLowerCase()] ?? service;
      const protocol = getAdvertisedServiceProtocol(upstreamService, flavor);
      return protocol ? [[service, [protocol]]] : [];
    });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * Image services always produce images, so advertise `outputs: ["image"]`
 * without requiring seller config. Explicit capability config wins per-field.
 */
function withImageServiceCapabilityDefaults(
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities> | undefined,
): Record<string, ServiceCapabilities> | undefined {
  const imageServices = Object.entries(serviceApiProtocols ?? {})
    .filter(([, protocols]) => protocols.includes('openai-images'))
    .map(([service]) => service);
  if (imageServices.length === 0) return serviceCapabilities;
  const merged: Record<string, ServiceCapabilities> = { ...serviceCapabilities };
  for (const service of imageServices) {
    merged[service] = { outputs: ['image'], ...merged[service] };
  }
  return merged;
}

const plugin: AntseedProviderPlugin = {
  name: 'openai',
  displayName: 'OpenAI-Compatible',
  version: '0.1.0',
  type: 'provider',
  description: 'Provide OpenAI-compatible API capacity (OpenAI, Together, OpenRouter, and similar)',
  configSchema: [
    { key: 'OPENAI_API_KEY', label: 'API Key', type: 'secret', required: true, description: 'OpenAI-compatible upstream API key' },
    { key: 'OPENAI_BASE_URL', label: 'Base URL', type: 'string', required: false, default: 'https://api.openai.com', description: 'OpenAI-compatible base URL' },
    { key: 'OPENAI_PROVIDER_FLAVOR', label: 'Provider Flavor', type: 'string', required: false, default: 'generic', description: 'Special handling profile: generic | openrouter' },
    { key: 'OPENAI_UPSTREAM_PROVIDER', label: 'Upstream Provider', type: 'string', required: false, description: 'Optional OpenRouter provider selector value' },
    { key: 'OPENAI_EXTRA_HEADERS_JSON', label: 'Extra Headers JSON', type: 'string', required: false, description: 'Optional JSON object of extra headers' },
    { key: 'OPENAI_BODY_INJECT_JSON', label: 'Body Inject JSON', type: 'string', required: false, description: 'Optional JSON object merged into request body' },
    { key: 'OPENAI_STRIP_HEADER_PREFIXES', label: 'Strip Header Prefixes', type: 'string[]', required: false, description: 'Comma-separated header prefixes to strip before relay' },
    { key: 'ANTSEED_INPUT_USD_PER_MILLION', label: 'Input Price', type: 'number', required: false, default: 10, description: 'Input price in USD per 1M tokens' },
    { key: 'ANTSEED_OUTPUT_USD_PER_MILLION', label: 'Output Price', type: 'number', required: false, default: 10, description: 'Output price in USD per 1M tokens' },
    { key: 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', label: 'Cached Input Price', type: 'number', required: false, description: 'Cached input price in USD per 1M tokens (defaults to input price)' },
    { key: 'ANTSEED_SERVICE_PRICING_JSON', label: 'Service Pricing JSON', type: 'string', required: false, description: 'Per-service pricing JSON' },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Service Unit Billing Models JSON', type: 'string', required: false, description: 'Per-service/protocol unit billing model JSON' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Service Capabilities JSON', type: 'string', required: false, description: 'Per-service model capability JSON (contextWindow, maxOutputTokens, inputs, outputs, reasoning, toolUse, structuredOutput, supportedParameters)' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Max Concurrency', type: 'number', required: false, default: 10, description: 'Max concurrent requests' },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Allowed Services', type: 'string[]', required: false, description: 'Service allow-list' },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Alias Map', type: 'string', required: false, description: 'JSON map of announced service → upstream model name (generic, works across all providers)' },
    { key: 'OPENAI_PATH_REWRITE_JSON', label: 'Path Rewrite', type: 'string', required: false, description: 'JSON map of path prefix rewrites, e.g. {"/v1":"/v4"} for APIs that use a different version prefix' },
    { key: 'ANTSEED_FALLBACK_UPSTREAMS_JSON', label: 'Fallback Upstreams', type: 'string', required: false, description: 'JSON array of backup upstreams for the same services ({baseUrl, apiKey?, services?, serviceAliasMap?, pathRewrite?}), tried in order when the main upstream fails' },
  ],

  createProvider(config: Record<string, string>): Provider {
    const apiKey = config['OPENAI_API_KEY']?.trim() ?? '';
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY is required');
    }

    const servicePricing = parseServicePricingJson(config['ANTSEED_SERVICE_PRICING_JSON']);
    const pricing: Provider['pricing'] = {
      defaults: {
        inputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_INPUT_USD_PER_MILLION'], 'ANTSEED_INPUT_USD_PER_MILLION', 10),
        outputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_OUTPUT_USD_PER_MILLION'], 'ANTSEED_OUTPUT_USD_PER_MILLION', 10),
        ...(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'] ? { cachedInputUsdPerMillion: parseNonNegativeNumber(config['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], 'ANTSEED_CACHED_INPUT_USD_PER_MILLION', 0) } : {}),
      },
      ...(servicePricing ? { services: servicePricing } : {}),
    };

    const maxConcurrency = parseInt(config['ANTSEED_MAX_CONCURRENCY'] ?? '10', 10);
    if (Number.isNaN(maxConcurrency)) {
      throw new Error('ANTSEED_MAX_CONCURRENCY must be a valid number');
    }

    const allowedServices = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    const configuredBaseUrl = config['OPENAI_BASE_URL']?.trim();
    const flavor = resolveFlavor(config['OPENAI_PROVIDER_FLAVOR'], configuredBaseUrl);
    const baseUrl = configuredBaseUrl && configuredBaseUrl.length > 0
      ? configuredBaseUrl
      : (flavor === 'openrouter' ? 'https://openrouter.ai/api' : 'https://api.openai.com');
    const upstreamProvider = config['OPENAI_UPSTREAM_PROVIDER']?.trim();
    const bodyInject = parseJsonObject(config['OPENAI_BODY_INJECT_JSON'], 'OPENAI_BODY_INJECT_JSON') ?? {};
    if (flavor === 'openrouter' && upstreamProvider) {
      bodyInject['provider'] = { only: [upstreamProvider] };
    }
    const extraHeaders = parseExtraHeaders(config['OPENAI_EXTRA_HEADERS_JSON']);
    const stripHeaderPrefixes = parseCsv(config['OPENAI_STRIP_HEADER_PREFIXES']).map((entry) => entry.toLowerCase());
    const effectiveStripHeaderPrefixes = stripHeaderPrefixes.length > 0
      ? stripHeaderPrefixes
      : (flavor === 'openrouter' ? ['anthropic-', 'x-stainless-'] : []);

    const tokenProvider = new StaticTokenProvider(apiKey);
    const serviceRewriteMap = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceApiProtocols = buildOpenAiServiceApiProtocols(allowedServices, flavor, serviceRewriteMap);
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const serviceCapabilities = withImageServiceCapabilityDefaults(
      serviceApiProtocols,
      parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']),
    );
    const pathRewrite = parseJsonObject(config['OPENAI_PATH_REWRITE_JSON'], 'OPENAI_PATH_REWRITE_JSON') as Record<string, string> | undefined;
    const fallbackUpstreams = parseFallbackUpstreamsJson(config['ANTSEED_FALLBACK_UPSTREAMS_JSON'])?.map((fallback) => ({
      baseUrl: fallback.baseUrl,
      ...(fallback.apiKey ? { authHeaderValue: `Bearer ${fallback.apiKey}` } : {}),
      ...(fallback.services ? { services: fallback.services } : {}),
      ...(fallback.serviceAliasMap ? { serviceRewriteMap: fallback.serviceAliasMap } : {}),
      ...(fallback.pathRewrite ? { pathRewrite: fallback.pathRewrite } : {}),
    }));

    return new BaseProvider({
      name: 'openai',
      services: allowedServices,
      pricing,
      ...(serviceApiProtocols ? { serviceApiProtocols } : {}),
      ...(serviceUnitBillingModels ? { serviceUnitBillingModels } : {}),
      ...(serviceCapabilities ? { serviceCapabilities } : {}),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        tokenProvider,
        maxConcurrency,
        allowedServices,
        ...(serviceRewriteMap ? { serviceRewriteMap } : {}),
        ...(effectiveStripHeaderPrefixes.length > 0 ? { stripHeaderPrefixes: effectiveStripHeaderPrefixes } : {}),
        ...(Object.keys(bodyInject).length > 0 ? { injectJsonFields: bodyInject } : {}),
        ...(extraHeaders ? { extraHeaders } : {}),
        ...(pathRewrite ? { pathRewrite } : {}),
        ...(fallbackUpstreams ? { fallbackUpstreams } : {}),
      },
    });
  },
};

export default plugin;

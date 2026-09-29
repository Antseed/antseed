import type { Provider, SerializedHttpRequest, SerializedHttpResponse } from '@antseed/node';
import { validateUnitBillingModelV1 } from '@antseed/node';
import { nativeVideoOptionError, nativeVideoRoute, requestService, type NativeVideoProtocol } from '@antseed/api-adapter';
import { BaseProvider } from './base-provider.js';
import type { RelayConfig } from './http-relay.js';
import { parseCsv, parseServiceUnitBillingModelsJson, parseServiceCapabilitiesJson } from './config-utils.js';

export interface NativeVideoProviderOptions {
  name: string;
  protocol: NativeVideoProtocol;
  relay: Pick<RelayConfig, 'baseUrl' | 'authHeaderName' | 'authHeaderValue' | 'extraHeaders'>;
}

export function createNativeVideoProvider(options: NativeVideoProviderOptions, config: Record<string, string>): Provider {
  const { name, protocol } = options;
  const baseUrl = options.relay.baseUrl?.trim();
  if (!baseUrl) throw new Error('Base URL must point to a seller-operated API');
  const url = new URL(baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Invalid seller API base URL');
  if (!options.relay.authHeaderName.trim() || !options.relay.authHeaderValue.trim()) throw new Error('Seller API authentication is required');
  const aliases = JSON.parse(config['ANTSEED_SERVICE_ALIAS_MAP_JSON'] ?? '{}') as Record<string, string>;
  if (Object.entries(aliases).some(([service, upstream]) => service !== upstream)) throw new Error('Native video services must use upstream model names; aliases are not supported');
  const services = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
  if (!services.length) throw new Error('ANTSEED_ALLOWED_SERVICES is required');
  const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
  for (const service of services) {
    const pricing = serviceUnitBillingModels?.[service]?.[protocol];
    if (!pricing) throw new Error(`Missing ${protocol} unit pricing for ${service}`);
    const errors = validateUnitBillingModelV1(pricing);
    if (errors.length) throw new Error(`Invalid video pricing: ${errors.join('; ')}`);
    if (pricing.components.some(component => !['video_generations', 'video_seconds'].includes(component.unit))) throw new Error('Video pricing must use video_generations or video_seconds');
  }
  const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
  const capabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
  const relay = new BaseProvider({
    name, services, pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    serviceUnitBillingModels,
    serviceApiProtocols: Object.fromEntries(services.map(service => [service, [protocol]])),
    serviceCapabilities: Object.fromEntries(services.map(service => [service, { ...capabilities?.[service], outputs: ['video'] }])),
    relay: { ...options.relay, baseUrl,
      maxConcurrency, allowedServices: [], preserveRequestBody: true, retryOn5xx: 0, redirect: 'error',
    },
  });
  const error = (request: SerializedHttpRequest, code: string, message: string): SerializedHttpResponse => ({
    requestId: request.requestId, statusCode: 400, headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ error: { code, message } })),
  });
  const handleRequest = async (request: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
    const route = nativeVideoRoute(request);
    const service = requestService(request);
    if (!route || route.protocol !== protocol || !service || !services.includes(service)) {
      return error(request, 'unsupported_video_request', 'Unsupported video endpoint or service');
    }
    const optionError = nativeVideoOptionError(request, provider.serviceCapabilities?.[service]?.video);
    if (optionError) return error(request, 'unsupported_video_options', optionError);
    const headers = { ...request.headers };
    for (const header of Object.keys(headers)) {
      if (header.toLowerCase().startsWith('x-antseed-') && header.toLowerCase() !== 'x-antseed-buyer-peer-id') delete headers[header];
    }
    const requestUrl = new URL(request.path, 'http://local');
    requestUrl.searchParams.delete('key');
    requestUrl.searchParams.delete('api_key');
    return relay.handleRequest({ ...request, headers, path: `${requestUrl.pathname}${requestUrl.search}` });
  };
  const provider: Provider = { name, services, pricing: relay.pricing, serviceApiProtocols: relay.serviceApiProtocols,
    serviceUnitBillingModels, serviceCapabilities: relay.serviceCapabilities, maxConcurrency,
    handleRequest, getCapacity: () => relay.getCapacity() };
  return provider;
}

import type { AntseedProviderPlugin, Provider, SerializedHttpRequest } from '@antseed/node';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION } from '@antseed/node';
import { nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';
import {
  BaseProvider,
  parseCsv,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  streamVideoResponse,
  videoDownloadError,
  videoDownloadSignal,
} from '@antseed/provider-core';

export const VENICE_DEFAULT_BASE_URL = 'https://api.venice.ai';

const PROTOCOL = 'venice-video';
const MAX_STATUS_BYTES = 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;

function error(request: SerializedHttpRequest, statusCode: number, code: string, message: string) {
  return videoDownloadError(request, statusCode, code, message);
}

function retrieveBody(service: string, queueId: string, deleteMedia: unknown): Uint8Array {
  return Buffer.from(JSON.stringify({
    model: service,
    queue_id: queueId,
    ...(typeof deleteMedia === 'boolean' ? { delete_media_on_completion: deleteMedia } : {}),
  }));
}

const plugin: AntseedProviderPlugin = {
  name: 'venice-video',
  displayName: 'Venice Video',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Relay native Venice video requests to the Venice API',
  configSchema: [
    { key: 'VENICE_VIDEO_BASE_URL', label: 'Venice API URL', type: 'string', default: VENICE_DEFAULT_BASE_URL },
    { key: 'VENICE_VIDEO_API_KEY', label: 'Venice API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config): Provider {
    const apiKey = config['VENICE_VIDEO_API_KEY']?.trim();
    if (!apiKey) throw new Error('VENICE_VIDEO_API_KEY is required');
    const baseUrl = (config['VENICE_VIDEO_BASE_URL']?.trim() || VENICE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('VENICE_VIDEO_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }
    if (config['ANTSEED_SERVICE_ALIAS_MAP_JSON']) throw new Error('Venice video services must use Venice model names');

    const services = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length === 0) throw new Error('ANTSEED_ALLOWED_SERVICES is required');
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const missingPricing = services.find(service => !serviceUnitBillingModels?.[service]?.[PROTOCOL]);
    if (missingPricing) throw new Error(`Missing ${PROTOCOL} unit pricing for ${missingPricing}`);
    const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const relay = new BaseProvider({
      name: 'venice-video',
      services,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: Object.fromEntries(services.map(service => [service, [PROTOCOL]])),
      serviceUnitBillingModels,
      serviceCapabilities: Object.fromEntries(services.map(service => [service, { ...configuredCapabilities?.[service], outputs: ['video'] }])),
      relay: {
        baseUrl,
        authHeaderName: 'authorization',
        authHeaderValue: `Bearer ${apiKey}`,
        maxConcurrency,
        allowedServices: services,
        preserveRequestBody: true,
        redirect: 'error',
        stripHeaderPrefixes: ['x-antseed-'],
      },
    });

    const route = (request: SerializedHttpRequest) => {
      const videoRoute = nativeVideoRoute(request);
      const service = requestService(request);
      return { videoRoute, service: service && services.includes(service) ? service : undefined };
    };

    let activeDownloads = 0;
    const handleRequest: Provider['handleRequest'] = async (request) => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return error(request, 400, 'unsupported_video_request', 'Unsupported video endpoint or service');
      return relay.handleRequest({ ...request, path: new URL(request.path, 'http://local').pathname });
    };

    return {
      name: relay.name,
      services,
      pricing: relay.pricing,
      serviceApiProtocols: relay.serviceApiProtocols,
      serviceUnitBillingModels,
      serviceCapabilities: relay.serviceCapabilities,
      maxConcurrency,
      getCapacity: () => relay.getCapacity(),
      handleRequest,
      async handleRequestStream(request, callbacks) {
        const { videoRoute, service } = route(request);
        if (videoRoute?.action !== 'retrieve') return handleRequest(request);
        if (!service || !videoRoute.resourceId) return error(request, 400, 'unsupported_video_request', 'Unsupported video service or queue_id');
        if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || !callbacks.signal) {
          return error(request, 400, 'unsupported_video_download', 'A streaming video download is required');
        }

        const download = videoDownloadSignal(callbacks.signal);
        let streaming = false;
        try {
          const upstream = await fetch(`${baseUrl}/api/v1/video/retrieve`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'accept-encoding': 'identity' },
            body: retrieveBody(service, videoRoute.resourceId, parseJsonObject(request.body)?.delete_media_on_completion),
            redirect: 'error',
            signal: download.signal,
          });
          const contentType = upstream.headers.get('content-type')?.split(';')[0]?.trim();
          if (upstream.status === 200 && contentType === 'video/mp4') {
            if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
              await upstream.body?.cancel();
              return error(request, 429, 'video_download_busy', 'Too many concurrent video downloads');
            }
            activeDownloads += 1;
            streaming = true;
            try {
              return await streamVideoResponse(request, upstream, callbacks, download);
            } finally {
              activeDownloads -= 1;
            }
          }
          const body = Buffer.from(await upstream.arrayBuffer());
          if (body.length > MAX_STATUS_BYTES || contentType !== 'application/json') {
            return error(request, 502, 'video_status_unavailable', 'Video status is unavailable');
          }
          return { requestId: request.requestId, statusCode: upstream.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body };
        } catch (cause) {
          if (streaming) throw cause;
          return error(request, download.signal.aborted ? 504 : 502, 'video_download_failed', 'Could not retrieve video from Venice');
        } finally {
          download.done();
        }
      },
    };
  },
};

export default plugin;

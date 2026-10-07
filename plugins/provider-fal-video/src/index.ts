import type { AntseedProviderPlugin, Provider, ProviderStreamCallbacks, SerializedHttpRequest } from '@antseed/node';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION } from '@antseed/node';
import { nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';
import {
  parseCsv,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  streamVideoResponse,
  videoDownloadError as error,
  videoDownloadSignal,
} from '@antseed/provider-core';

export const FAL_DEFAULT_BASE_URL = 'https://queue.fal.run';

const PROTOCOL = 'fal-video';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;
/** fal endpoint IDs: `owner/alias[/path...]`, at most 64 characters (the discovery service-name limit). */
const ENDPOINT_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

function json(request: SerializedHttpRequest, statusCode: number, body: Record<string, unknown>) {
  return {
    requestId: request.requestId,
    statusCode,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    body: Buffer.from(JSON.stringify(body)),
  };
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const body = Buffer.from(await response.arrayBuffer());
  return body.length <= MAX_JSON_BYTES ? parseJsonObject(body) : null;
}

/** fal's queue status and result URLs use only `owner/alias`, not the endpoint's sub-path. */
export function falAppId(endpointId: string): string {
  return endpointId.split('/').slice(0, 2).join('/');
}

const plugin: AntseedProviderPlugin = {
  name: 'fal-video',
  displayName: 'fal Video',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Relay fal.ai video model requests through the fal queue API',
  configSchema: [
    { key: 'FAL_VIDEO_BASE_URL', label: 'fal Queue URL', type: 'string', default: FAL_DEFAULT_BASE_URL },
    { key: 'FAL_VIDEO_API_KEY', label: 'fal API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config): Provider {
    const apiKey = config['FAL_VIDEO_API_KEY']?.trim();
    if (!apiKey) throw new Error('FAL_VIDEO_API_KEY is required');
    const baseUrl = (config['FAL_VIDEO_BASE_URL']?.trim() || FAL_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('FAL_VIDEO_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }
    if (config['ANTSEED_SERVICE_ALIAS_MAP_JSON']) throw new Error('fal video services must use fal endpoint IDs');

    const services = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length === 0) throw new Error('ANTSEED_ALLOWED_SERVICES is required');
    const invalid = services.find(service => service.length > 64 || !ENDPOINT_ID.test(service));
    if (invalid) throw new Error(`Invalid fal endpoint ID: ${invalid}`);
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const missingPricing = services.find(service => !serviceUnitBillingModels?.[service]?.[PROTOCOL]);
    if (missingPricing) throw new Error(`Missing ${PROTOCOL} unit pricing for ${missingPricing}`);
    const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const authorization = `Key ${apiKey}`;

    const route = (request: SerializedHttpRequest) => {
      const videoRoute = nativeVideoRoute(request);
      const service = requestService(request);
      return { videoRoute, service: service && services.includes(service) ? service : undefined };
    };

    let active = 0;
    let activeDownloads = 0;

    const handleRequest: Provider['handleRequest'] = async (request) => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return error(request, 400, 'unsupported_video_request', 'Unsupported video endpoint or service');
      const body = parseJsonObject(request.body);
      if (!body) return error(request, 400, 'invalid_video_request', 'Video request must be a JSON object');
      if (active >= maxConcurrency) return error(request, 429, 'max_concurrency', 'Max concurrency reached');
      active += 1;
      try {
        // fal reads the model from the URL; the body is the model input only.
        const { model: _model, service: _service, ...input } = body;
        const upstream = await fetch(`${baseUrl}/${service}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          redirect: 'error',
          signal: AbortSignal.timeout(60_000),
        });
        const accepted = await readJson(upstream);
        if (upstream.status >= 400 && upstream.status < 500) {
          return json(request, upstream.status, { error: { code: 'fal_request_rejected', message: JSON.stringify(accepted?.detail ?? accepted?.error ?? null).slice(0, 500) } });
        }
        if (!upstream.ok || typeof accepted?.request_id !== 'string') return error(request, 502, 'fal_request_failed', 'fal did not accept the request');
        // fal's status/response URLs need the seller's key, so only the ID is returned.
        return json(request, 200, { model: service, request_id: accepted.request_id, status: 'IN_QUEUE' });
      } catch {
        return error(request, 502, 'fal_request_failed', 'Could not submit the request to fal');
      } finally {
        active -= 1;
      }
    };

    const streamUpstream = async (request: SerializedHttpRequest, upstream: Response, callbacks: ProviderStreamCallbacks, download: ReturnType<typeof videoDownloadSignal>) => {
      if (activeDownloads >= MAX_ACTIVE_DOWNLOADS) {
        await upstream.body?.cancel();
        return error(request, 429, 'video_download_busy', 'Too many concurrent video downloads');
      }
      activeDownloads += 1;
      try {
        return await streamVideoResponse(request, upstream, callbacks, download);
      } finally {
        activeDownloads -= 1;
      }
    };

    return {
      name: 'fal-video',
      services,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: Object.fromEntries(services.map(service => [service, [PROTOCOL]])),
      serviceUnitBillingModels,
      serviceCapabilities: Object.fromEntries(services.map(service => [service, { ...configuredCapabilities?.[service], outputs: ['video'] }])),
      maxConcurrency,
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      handleRequest,
      async handleRequestStream(request, callbacks) {
        const { videoRoute, service } = route(request);
        if (videoRoute?.action !== 'retrieve') return handleRequest(request);
        if (!service || !videoRoute.resourceId) return error(request, 400, 'unsupported_video_request', 'Unsupported video service or request_id');
        if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || !callbacks.signal) {
          return error(request, 400, 'unsupported_video_download', 'A streaming video download is required');
        }

        const download = videoDownloadSignal(callbacks.signal);
        const requestUrl = `${baseUrl}/${falAppId(service)}/requests/${videoRoute.resourceId}`;
        const get = (target: string) => fetch(target, { headers: { authorization }, redirect: 'error', signal: download.signal });
        let streaming = false;
        try {
          const statusResponse = await get(`${requestUrl}/status`);
          const status = await readJson(statusResponse);
          if (statusResponse.status === 404) return error(request, 404, 'resource_not_found', 'Video job not found');
          if (status?.status === 'IN_QUEUE' || status?.status === 'IN_PROGRESS') return json(request, 200, { status: status.status });
          if (status?.status !== 'COMPLETED') return error(request, 502, 'video_status_unavailable', 'Video status is unavailable');
          // FAILED lets the seller release the job's one-off payment channel at once.
          if (status.error) return json(request, 200, { status: 'FAILED', error: String(status.error).slice(0, 500) });

          const resultResponse = await get(requestUrl);
          const result = await readJson(resultResponse);
          if (!resultResponse.ok) return json(request, 200, { status: 'FAILED' });
          const video = result?.video as { url?: unknown } | undefined;
          if (typeof video?.url !== 'string' || !video.url.startsWith('https://')) {
            return error(request, 502, 'video_download_unavailable', 'fal result has no video');
          }
          // fal media URLs are public; never send the seller key to them.
          const file = await fetch(video.url, { headers: { 'accept-encoding': 'identity' }, signal: download.signal });
          streaming = true;
          return await streamUpstream(request, file, callbacks, download);
        } catch (cause) {
          if (streaming) throw cause;
          return error(request, download.signal.aborted ? 504 : 502, 'video_download_failed', 'Could not retrieve video from fal');
        } finally {
          download.done();
        }
      },
    };
  },
};

export default plugin;

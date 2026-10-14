import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
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
/** Venice pre-signed download URLs are valid for 24 hours. */
const DOWNLOAD_URL_TTL_MS = 24 * 60 * 60_000;
const MAX_DOWNLOAD_URLS = 1000;
const DOWNLOAD_URLS_FILE = 'venice-video-download-urls.json';

type DownloadUrls = Map<string, { url: string; expiresAt: number }>;

/**
 * Pending download URLs survive a seller restart in the seller's data
 * directory: the URL is only returned on create, so losing it loses the video.
 */
function loadDownloadUrls(dataDir: string | undefined): DownloadUrls {
  const urls: DownloadUrls = new Map();
  if (!dataDir) return urls;
  try {
    const stored = JSON.parse(readFileSync(join(dataDir, DOWNLOAD_URLS_FILE), 'utf8')) as Record<string, { url?: unknown; expiresAt?: unknown }>;
    const now = Date.now();
    for (const [queueId, entry] of Object.entries(stored)) {
      if (typeof entry?.url === 'string' && typeof entry.expiresAt === 'number' && entry.expiresAt > now) {
        urls.set(queueId, { url: entry.url, expiresAt: entry.expiresAt });
      }
    }
  } catch {
    // No saved URLs yet, or an unreadable file: start empty.
  }
  return urls;
}

function saveDownloadUrls(dataDir: string | undefined, urls: DownloadUrls): void {
  if (!dataDir) return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const file = join(dataDir, DOWNLOAD_URLS_FILE);
    writeFileSync(`${file}.tmp`, JSON.stringify(Object.fromEntries(urls)), { mode: 0o600 });
    renameSync(`${file}.tmp`, file);
  } catch (err) {
    console.warn(`[venice-video] Could not save download URLs: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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
    // Private (VPS-backed) Venice models return a pre-signed download_url on
    // create instead of streaming the file from retrieve. The seller keeps
    // that URL and streams the file itself, so every video reaches the buyer
    // through the same checked, charge-on-delivery download.
    const dataDir = config['ANTSEED_DATA_DIR']?.trim() || undefined;
    const downloadUrls = loadDownloadUrls(dataDir);
    const keepDownloadUrl = (queueId: string, url: string) => {
      const now = Date.now();
      for (const [key, entry] of downloadUrls) if (entry.expiresAt <= now) downloadUrls.delete(key);
      downloadUrls.set(queueId, { url, expiresAt: now + DOWNLOAD_URL_TTL_MS });
      while (downloadUrls.size > MAX_DOWNLOAD_URLS) downloadUrls.delete(downloadUrls.keys().next().value!);
      saveDownloadUrls(dataDir, downloadUrls);
    };
    const takeDownloadUrl = (queueId: string): string | undefined => {
      const entry = downloadUrls.get(queueId);
      if (entry && entry.expiresAt > Date.now()) return entry.url;
      if (downloadUrls.delete(queueId)) saveDownloadUrls(dataDir, downloadUrls);
      return undefined;
    };

    const handleRequest: Provider['handleRequest'] = async (request) => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return error(request, 400, 'unsupported_video_request', 'Unsupported video endpoint or service');
      const response = await relay.handleRequest({ ...request, path: new URL(request.path, 'http://local').pathname });
      const body = response.statusCode === 200 ? parseJsonObject(response.body) : null;
      if (typeof body?.queue_id !== 'string' || typeof body.download_url !== 'string') return response;
      const { download_url: downloadUrl, ...rest } = body;
      keepDownloadUrl(body.queue_id, downloadUrl);
      const headers = Object.fromEntries(Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== 'content-length'));
      return { ...response, headers, body: Buffer.from(JSON.stringify(rest)) };
    };

    const streamUpstream = async (request: SerializedHttpRequest, upstream: Response, callbacks: Parameters<NonNullable<Provider['handleRequestStream']>>[1], download: ReturnType<typeof videoDownloadSignal>) => {
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
            streaming = true;
            return await streamUpstream(request, upstream, callbacks, download);
          }
          const body = Buffer.from(await upstream.arrayBuffer());
          if (body.length > MAX_STATUS_BYTES || contentType !== 'application/json') {
            return error(request, 502, 'video_status_unavailable', 'Video status is unavailable');
          }
          const downloadUrl = upstream.status === 200 && parseJsonObject(body)?.status === 'COMPLETED'
            ? takeDownloadUrl(videoRoute.resourceId)
            : undefined;
          if (downloadUrl) {
            const file = await fetch(downloadUrl, { headers: { 'accept-encoding': 'identity' }, redirect: 'error', signal: download.signal });
            streaming = true;
            return await streamUpstream(request, file, callbacks, download);
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

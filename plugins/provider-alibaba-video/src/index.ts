import type { AntseedProviderPlugin, Provider, ProviderRequestRefusal, SerializedHttpRequest, ServiceCapabilities, UpstreamAccountStatus } from '@antseed/node';
import { MAX_SERVICE_NAME_LENGTH, VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, isContentFreeLogging } from '@antseed/node';
import { nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';
import {
  parseCsv,
  parseServiceAliasMap,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  createVideoResponseStreamer,
  readVideoJson as readJson,
  videoDownloadError as error,
  videoDownloadSignal,
  videoJsonResponse as json,
  videoSubmitTimeoutMs,
} from '@antseed/provider-core';

/** Model Studio's Singapore endpoint. API keys belong to one region. */
export const ALIBABA_DEFAULT_BASE_URL = 'https://dashscope-intl.aliyuncs.com';

/**
 * Antseed's queue paths and request shape for video, which buyers already speak.
 * The seller translates them to Model Studio's task API.
 */
const PROTOCOL = 'fal-video';
const CREATE_PATH = '/api/v1/services/aigc/video-generation/video-synthesis';
const TASKS_PATH = '/api/v1/tasks';
const ACCOUNT_CHECK_PATH = '/compatible-mode/v1/models';
const MAX_ACTIVE_DOWNLOADS = 2;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;

/** Request fields the seller translates, announced to buyers unless the seller configured its own list. */
export const SUPPORTED_PARAMETERS = [
  'aspect_ratio', 'audio', 'duration', 'enable_prompt_expansion', 'end_image_url', 'image_url',
  'prompt', 'reference_image_urls', 'resolution', 'seed', 'start_image_url',
];

/**
 * Inputs the seller refuses. Model Studio bills an input video on top of the
 * output, which a buyer's `duration` does not cover, and these models would
 * otherwise ignore or misuse an input the buyer expected to count.
 */
const UNSUPPORTED_INPUTS = ['audio_url', 'video_url', 'reference_video_urls'];

/** Why a create can't be priced or served, or null. Run before any payment. */
export function alibabaRequestProblem(input: Record<string, unknown>): string | null {
  const unsupported = UNSUPPORTED_INPUTS.find(field => input[field] !== undefined);
  if (unsupported) return `${unsupported} is not supported by this seller`;
  // The buyer pays for `duration`, and Model Studio picks its own length without one.
  if (input.duration === undefined || input.duration === null) return 'duration is required: this service is paid by the second';
  return null;
}

function firstString(input: Record<string, unknown>, fields: readonly string[]): string | undefined {
  for (const field of fields) {
    const value = input[field];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

/** Model Studio's task body for an Antseed create. */
export function alibabaTaskBody(model: string, input: Record<string, unknown>): Record<string, unknown> {
  const firstFrame = firstString(input, ['start_image_url', 'image_url']);
  const lastFrame = firstString(input, ['end_image_url']);
  const references = Array.isArray(input.reference_image_urls)
    ? input.reference_image_urls.filter((url): url is string => typeof url === 'string' && url.length > 0)
    : [];
  const media = [
    ...(firstFrame ? [{ type: 'first_frame', url: firstFrame }] : []),
    ...(lastFrame ? [{ type: 'last_frame', url: lastFrame }] : []),
    ...references.map(url => ({ type: 'reference_image', url })),
  ];
  const duration = typeof input.duration === 'string' ? Number(input.duration.trim().replace(/s$/, '')) : input.duration;
  return {
    model,
    input: {
      ...(typeof input.prompt === 'string' ? { prompt: input.prompt } : {}),
      ...(media.length > 0 ? { media } : {}),
    },
    parameters: {
      duration,
      // Pricing matches the buyer's own spelling (`720p`); Model Studio takes `720P`.
      ...(typeof input.resolution === 'string' ? { resolution: input.resolution.toUpperCase() } : {}),
      ...(typeof input.aspect_ratio === 'string' ? { ratio: input.aspect_ratio } : {}),
      ...(typeof input.audio === 'boolean' ? { audio: input.audio } : {}),
      ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
      ...(typeof input.enable_prompt_expansion === 'boolean' ? { prompt_extend: input.enable_prompt_expansion } : {}),
    },
  };
}

/** A readable reason from a Model Studio error body. */
export function alibabaErrorReason(body: Record<string, unknown> | null | undefined): string | undefined {
  const message = body?.message;
  if (typeof message === 'string' && message.trim()) return message.slice(0, 500);
  const code = body?.code;
  return typeof code === 'string' && code.trim() ? code.slice(0, 500) : undefined;
}

const plugin: AntseedProviderPlugin = {
  name: 'alibaba-video',
  displayName: 'Alibaba Video',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Relay video requests to Alibaba Cloud Model Studio (Wan, HappyHorse)',
  configSchema: [
    { key: 'ALIBABA_VIDEO_BASE_URL', label: 'Model Studio URL', type: 'string', default: ALIBABA_DEFAULT_BASE_URL },
    { key: 'ALIBABA_VIDEO_API_KEY', label: 'Model Studio API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_ALIAS_MAP_JSON', label: 'Service Aliases', type: 'string' },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
  ],
  createProvider(config): Provider {
    const apiKey = config['ALIBABA_VIDEO_API_KEY']?.trim();
    if (!apiKey) throw new Error('ALIBABA_VIDEO_API_KEY is required');
    const baseUrl = (config['ALIBABA_VIDEO_BASE_URL']?.trim() || ALIBABA_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('ALIBABA_VIDEO_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }

    const services = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length === 0) throw new Error('ANTSEED_ALLOWED_SERVICES is required');
    const tooLong = services.find(service => service.length > MAX_SERVICE_NAME_LENGTH);
    if (tooLong) throw new Error(`Service ID is longer than ${MAX_SERVICE_NAME_LENGTH} characters: ${tooLong}`);
    const aliases = parseServiceAliasMap(config['ANTSEED_SERVICE_ALIAS_MAP_JSON']);
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const missingPricing = services.find(service => !serviceUnitBillingModels?.[service]?.[PROTOCOL]);
    if (missingPricing) throw new Error(`Missing ${PROTOCOL} unit pricing for ${missingPricing}`);
    const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const authorization = `Bearer ${apiKey}`;

    const serviceCapabilities: Record<string, ServiceCapabilities> = Object.fromEntries(
      services.map(service => [service, { supportedParameters: SUPPORTED_PARAMETERS, ...configuredCapabilities?.[service], outputs: ['video'] }]),
    );

    const route = (request: SerializedHttpRequest) => {
      const videoRoute = nativeVideoRoute(request);
      const service = requestService(request);
      return { videoRoute, service: service && services.includes(service) ? service : undefined };
    };

    // Run before any payment, so a refused create costs the buyer nothing.
    const checkRequest = (request: SerializedHttpRequest): ProviderRequestRefusal | null => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return null;
      const body = parseJsonObject(request.body);
      const refused = body && alibabaRequestProblem(body);
      return refused ? { statusCode: 422, code: 'invalid_video_request', message: refused } : null;
    };

    let active = 0;

    const handleRequest: Provider['handleRequest'] = async (request) => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return error(request, 400, 'unsupported_video_request', 'Unsupported video endpoint or service');
      const body = parseJsonObject(request.body);
      if (!body) return error(request, 400, 'invalid_video_request', 'Video request must be a JSON object');
      // The seller checks this before payment too (checkRequest).
      const refused = alibabaRequestProblem(body);
      if (refused) return error(request, 422, 'invalid_video_request', refused);
      if (active >= maxConcurrency) return error(request, 429, 'max_concurrency', 'Max concurrency reached');
      active += 1;
      try {
        const upstream = await fetch(`${baseUrl}${CREATE_PATH}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json', 'x-dashscope-async': 'enable' },
          body: JSON.stringify(alibabaTaskBody(aliases?.[service.toLowerCase()] ?? service, body)),
          redirect: 'error',
          signal: AbortSignal.timeout(videoSubmitTimeoutMs(request.body.length)),
        });
        const accepted = await readJson(upstream);
        if (upstream.status >= 400 && upstream.status < 500) {
          return json(request, upstream.status, { error: { code: 'alibaba_request_rejected', message: alibabaErrorReason(accepted) ?? `Model Studio answered HTTP ${upstream.status}` } });
        }
        const taskId = (accepted?.output as { task_id?: unknown } | undefined)?.task_id;
        if (!upstream.ok || typeof taskId !== 'string') return error(request, 502, 'alibaba_request_failed', 'Model Studio did not accept the request');
        return json(request, 200, { model: service, request_id: taskId, status: 'IN_QUEUE' });
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'TimeoutError') {
          return error(request, 504, 'upstream_upload_timeout', `Sending the request to Model Studio timed out (${(request.body.length / 1_000_000).toFixed(1)} MB). Send images as public https URLs or smaller files`);
        }
        return error(request, 502, 'alibaba_request_failed', 'Could not submit the request to Model Studio');
      } finally {
        active -= 1;
      }
    };

    const streamUpstream = createVideoResponseStreamer(MAX_ACTIVE_DOWNLOADS);

    return {
      name: 'alibaba-video',
      services,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: Object.fromEntries(services.map(service => [service, [PROTOCOL]])),
      serviceUnitBillingModels,
      serviceCapabilities,
      maxConcurrency,
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      checkRequest,
      handleRequest,
      // Model Studio has no free per-model check for video, so only the key is checked.
      async checkUpstreamAccount(): Promise<UpstreamAccountStatus> {
        try {
          const response = await fetch(`${baseUrl}${ACCOUNT_CHECK_PATH}`, {
            headers: { authorization },
            redirect: 'error',
            signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
          });
          await response.body?.cancel();
          if (response.status === 401 || response.status === 403) {
            return { status: 'unavailable', reason: `Model Studio rejected the API key (HTTP ${response.status})` };
          }
          return response.ok ? { status: 'available' } : { status: 'unknown', reason: `Model Studio key check returned HTTP ${response.status}` };
        } catch (cause) {
          return { status: 'unknown', reason: `Model Studio key check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
        }
      },
      async handleRequestStream(request, callbacks) {
        const { videoRoute, service } = route(request);
        if (videoRoute?.action !== 'retrieve') return handleRequest(request);
        if (!service || !videoRoute.resourceId) return error(request, 400, 'unsupported_video_request', 'Unsupported video service or request_id');
        if (request.headers[VIDEO_DOWNLOAD_STREAM_HEADER] !== VIDEO_DOWNLOAD_STREAM_VERSION || !callbacks.signal) {
          return error(request, 400, 'unsupported_video_download', 'A streaming video download is required');
        }

        const download = videoDownloadSignal(callbacks.signal);
        let streaming = false;
        try {
          const response = await fetch(`${baseUrl}${TASKS_PATH}/${videoRoute.resourceId}`, { headers: { authorization }, redirect: 'error', signal: download.signal });
          const task = await readJson(response);
          // A temporary error must not end the job: FAILED releases its payment channel.
          if (!response.ok) {
            return response.status === 404
              ? error(request, 404, 'resource_not_found', 'Video job not found')
              : error(request, 502, 'video_status_unavailable', 'Video status is unavailable');
          }
          const output = task?.output as { task_status?: unknown; video_url?: unknown; code?: unknown; message?: unknown } | undefined;
          switch (output?.task_status) {
            case 'PENDING':
              return json(request, 200, { status: 'IN_QUEUE' });
            case 'RUNNING':
              return json(request, 200, { status: 'IN_PROGRESS' });
            case 'UNKNOWN':
              return error(request, 404, 'resource_not_found', 'Video job not found');
            case 'FAILED':
            case 'CANCELED': {
              // FAILED lets the seller release the job's one-off payment channel at once.
              const reason = alibabaErrorReason(output as Record<string, unknown>) ?? `Model Studio reports the job ${output.task_status}`;
              // A moderation reason can describe the buyer's prompt or media.
              console.warn(`[alibaba-video] ${service} job ${videoRoute.resourceId} failed${isContentFreeLogging() ? '' : `: ${reason}`}`);
              return json(request, 200, { status: 'FAILED', error: reason });
            }
            case 'SUCCEEDED':
              break;
            default:
              return error(request, 502, 'video_status_unavailable', 'Video status is unavailable');
          }
          if (typeof output.video_url !== 'string' || !output.video_url.startsWith('https://')) {
            return error(request, 502, 'video_download_unavailable', 'Model Studio result has no video');
          }
          // Result URLs are signed; never send the seller key to them.
          const file = await fetch(output.video_url, { headers: { 'accept-encoding': 'identity' }, signal: download.signal });
          streaming = true;
          return await streamUpstream(request, file, callbacks, download);
        } catch (cause) {
          if (streaming) throw cause;
          return error(request, download.signal.aborted ? 504 : 502, 'video_download_failed', 'Could not retrieve video from Model Studio');
        } finally {
          download.done();
        }
      },
    };
  },
};

export default plugin;

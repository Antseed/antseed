import type { AntseedProviderPlugin, Provider, ProviderStreamCallbacks, SerializedHttpRequest, ServiceCapabilities, ServiceHealthStatus, UpstreamAccountStatus } from '@antseed/node';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, validateServiceCapabilityFields } from '@antseed/node';
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
export const FAL_PLATFORM_URL = 'https://api.fal.ai';
export const FAL_SCHEMA_URL = 'https://fal.ai/api/openapi/queue/openapi.json';

const PROTOCOL = 'fal-video';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
/** Endpoint IDs per fal model-list request. */
const MODEL_LOOKUP_BATCH = 50;
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

/** fal input field names from an endpoint's OpenAPI schema, or null when they cannot be announced as-is. */
export function falInputParameters(schema: Record<string, unknown> | null, endpointId: string): string[] | null {
  const paths = schema?.paths as Record<string, any> | undefined;
  const ref = paths?.[`/${endpointId}`]?.post?.requestBody?.content?.['application/json']?.schema?.$ref;
  if (typeof ref !== 'string') return null;
  const properties = (schema?.components as Record<string, any> | undefined)?.schemas?.[ref.split('/').pop()!]?.properties;
  if (!properties || typeof properties !== 'object') return null;
  const parameters = Object.keys(properties).sort();
  return parameters.length > 0 && validateServiceCapabilityFields({ supportedParameters: parameters }).length === 0 ? parameters : null;
}

const FRAME_INPUT_FIELDS = {
  first_frame: ['image_url', 'start_image_url', 'first_frame_url', 'first_image_url'],
  last_frame: ['end_image_url', 'tail_image_url', 'last_frame_url', 'last_image_url'],
} as const;

/**
 * Adds the frame inputs an endpoint's fields take (for example Kling's
 * `tail_image_url`) to the seller's announced video inputs. Leaves unannounced
 * inputs unknown, because `inputs` is read as the complete list.
 */
export function withFrameInputs(capabilities: ServiceCapabilities): ServiceCapabilities {
  const parameters = capabilities.supportedParameters ?? [];
  const inputs = capabilities.video?.inputs;
  if (!inputs) return capabilities;
  const added = (Object.keys(FRAME_INPUT_FIELDS) as (keyof typeof FRAME_INPUT_FIELDS)[])
    .filter(input => !inputs.includes(input) && FRAME_INPUT_FIELDS[input].some(field => parameters.includes(field)));
  return added.length > 0 ? { ...capabilities, video: { ...capabilities.video, inputs: [...inputs, ...added] } } : capabilities;
}

/** fal's queue status and result URLs use only `owner/alias`, not the endpoint's sub-path. */
export function falAppId(endpointId: string): string {
  return endpointId.split('/').slice(0, 2).join('/');
}

type FalAccount =
  | { status: 'ok'; balanceUsd: number }
  | { status: 'unknown'; reason: string };

/**
 * Read fal's public model list for the given endpoint IDs: endpoint ID →
 * status (`active`, `deprecated`, ...). IDs missing from the result no longer
 * exist on fal. Returns null when fal does not answer clearly. fal answers a
 * whole lookup with `404 Endpoint(s) not found` when any one requested
 * endpoint is unknown, so such a lookup is repeated per endpoint.
 */
async function readFalModelStatuses(platformUrl: string, services: string[]): Promise<Map<string, string> | null> {
  const statuses = new Map<string, string>();
  const lookup = async (ids: string[]): Promise<boolean> => {
    const query = new URLSearchParams(ids.map((id): [string, string] => ['endpoint_id', id]));
    const response = await fetch(`${platformUrl}/v1/models?${query}`, { redirect: 'error', signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
    if (response.status === 404) {
      const error = (await readJson(response))?.error as { message?: unknown } | undefined;
      if (error?.message !== 'Endpoint(s) not found') return false;
      if (ids.length === 1) return true;
      for (const id of ids) {
        if (!await lookup([id])) return false;
      }
      return true;
    }
    if (!response.ok) return false;
    const models = (await readJson(response))?.models;
    if (!Array.isArray(models)) return false;
    for (const model of models as Array<{ endpoint_id?: unknown; metadata?: { status?: unknown } }>) {
      if (typeof model?.endpoint_id === 'string') {
        statuses.set(model.endpoint_id, typeof model.metadata?.status === 'string' ? model.metadata.status : 'active');
      }
    }
    return true;
  };
  try {
    for (let start = 0; start < services.length; start += MODEL_LOOKUP_BATCH) {
      if (!await lookup(services.slice(start, start + MODEL_LOOKUP_BATCH))) return null;
    }
    return statuses;
  } catch {
    return null;
  }
}

/** Read the account's credit balance. Needs a key with the `billing:usage:read` permission. */
async function readFalAccount(platformUrl: string, billingKey: string): Promise<FalAccount> {
  try {
    const response = await fetch(`${platformUrl}/v1/account/billing?expand=credits`, {
      headers: { authorization: `Key ${billingKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'unknown', reason: `fal rejected FAL_VIDEO_BILLING_API_KEY (HTTP ${response.status}); it needs the billing:usage:read permission` };
    }
    if (!response.ok) return { status: 'unknown', reason: `fal billing check returned HTTP ${response.status}` };
    const credits = (await readJson(response))?.credits as { current_balance?: unknown } | undefined;
    if (typeof credits?.current_balance !== 'number') return { status: 'unknown', reason: 'fal billing check returned no balance' };
    return { status: 'ok', balanceUsd: credits.current_balance };
  } catch (cause) {
    return { status: 'unknown', reason: `fal billing check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
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
    {
      key: 'FAL_VIDEO_BILLING_API_KEY',
      label: 'fal Billing API Key',
      type: 'secret',
      description: 'Optional fal key with the billing:usage:read permission. Lets the seller stop advertising models while credits are low and advertise them again after a top-up',
    },
    {
      key: 'FAL_VIDEO_MIN_BALANCE_USD',
      label: 'Minimum Balance (USD)',
      type: 'number',
      default: 0,
      description: 'With a billing key, stop advertising video models while the fal balance is at or below this amount',
    },
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
    const billingKey = config['FAL_VIDEO_BILLING_API_KEY']?.trim() || undefined;
    const minBalanceUsd = Number(config['FAL_VIDEO_MIN_BALANCE_USD'] ?? 0);
    if (!Number.isFinite(minBalanceUsd) || minBalanceUsd < 0) throw new Error('FAL_VIDEO_MIN_BALANCE_USD must be a non-negative number');
    const warned = new Set<string>();
    const warnOnce = (message: string) => {
      if (warned.has(message)) return;
      warned.add(message);
      console.warn(`[fal-video] ${message}`);
    };

    const serviceCapabilities: Record<string, ServiceCapabilities> = Object.fromEntries(
      services.map(service => [service, { ...configuredCapabilities?.[service], outputs: ['video'] }]),
    );

    // Announces each endpoint's own input field names, so buyers can call fal's API unchanged.
    const init = async () => {
      await Promise.all(services.filter(service => !serviceCapabilities[service]!.supportedParameters).map(async service => {
        try {
          const response = await fetch(`${FAL_SCHEMA_URL}?endpoint_id=${encodeURIComponent(service)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
          const parameters = response.ok ? falInputParameters(await readJson(response), service) : null;
          if (parameters) serviceCapabilities[service]!.supportedParameters = parameters;
        } catch {
          // Unknown input fields: buyers fall back to the common names.
        }
      }));
      for (const service of services) serviceCapabilities[service] = withFrameInputs(serviceCapabilities[service]!);
    };

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
      serviceCapabilities,
      maxConcurrency,
      getCapacity: () => ({ current: active, max: maxConcurrency }),
      init,
      handleRequest,
      async checkServiceHealth(checked) {
        const statuses = await readFalModelStatuses(FAL_PLATFORM_URL, checked);
        return Object.fromEntries(checked.map((service): [string, ServiceHealthStatus] => {
          if (!statuses) return [service, { status: 'unknown', reason: 'fal model list unavailable' }];
          const status = statuses.get(service);
          if (!status) return [service, { status: 'unavailable', reason: 'fal no longer offers this endpoint' }];
          if (status !== 'active' && status !== 'deprecated') {
            return [service, { status: 'unavailable', reason: `fal reports this endpoint ${status}` }];
          }
          if (status === 'deprecated') warnOnce(`${service} is deprecated on fal and may stop working; consider replacing it`);
          return [service, { status: 'available' }];
        }));
      },
      ...(billingKey && {
        async checkUpstreamAccount(): Promise<UpstreamAccountStatus> {
          const account = await readFalAccount(FAL_PLATFORM_URL, billingKey);
          if (account.status === 'unknown') {
            warnOnce(account.reason);
            return account;
          }
          if (account.balanceUsd <= minBalanceUsd) {
            return { status: 'unavailable', reason: `fal balance $${account.balanceUsd.toFixed(2)} is at or below the $${minBalanceUsd} minimum` };
          }
          return { status: 'available', balanceUsd: account.balanceUsd };
        },
      }),
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
          if (!resultResponse.ok) {
            // A temporary fal error must not end the job: FAILED releases its
            // payment channel, and the next retrieve may still deliver the video.
            if (resultResponse.status === 408 || resultResponse.status === 429 || resultResponse.status >= 500) {
              return error(request, 502, 'video_result_unavailable', 'fal result is temporarily unavailable');
            }
            return json(request, 200, { status: 'FAILED' });
          }
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

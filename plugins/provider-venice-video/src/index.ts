import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, ServiceCapabilities, ServiceHealthStatus, UpstreamAccountStatus, VideoInputKind } from '@antseed/node';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, validateServiceCapabilityFields } from '@antseed/node';
import { nativeVideoFacts, nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';
import {
  BaseProvider,
  createVideoSourcePrecheck,
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
const MAX_MODELS_BYTES = 4 * 1024 * 1024;
const MAX_ACTIVE_DOWNLOADS = 2;
/** Venice pre-signed download URLs are valid for 24 hours. */
const DOWNLOAD_URL_TTL_MS = 24 * 60 * 60_000;
const MAX_DOWNLOAD_URLS = 1000;
const DOWNLOAD_URLS_FILE = 'venice-video-download-urls.json';
const HEALTH_CHECK_TIMEOUT_MS = 15_000;
/** Venice allows 40 video requests a minute per key, and the end-frame check counts toward it. */
const END_FRAME_CHECK_INTERVAL_MS = 1_600;
const END_FRAME_CHECK_DURATION = '999s';
const END_FRAME_CHECK_IMAGE = 'data:image/png;base64,AAAA';

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

const FRAME_FIELDS = { first_frame: 'image_url', last_frame: 'end_image_url', reference_image: 'reference_image_urls' } as const;

/**
 * Largest create body Venice accepts. Measured on 2026-10-23: 32.5 MB passed
 * validation, 33.5 MB got an HTML `413 Request Entity Too Large`.
 */
export const VENICE_MAX_BODY_BYTES = 32_500_000;

/**
 * Source video lengths of Venice's video-to-video models, in seconds. These
 * are the model makers' own limits (the same models on fal state them);
 * Venice's model list does not.
 */
const KNOWN_SOURCE_SECONDS: Array<[RegExp, { minSeconds: number; maxSeconds: number }]> = [
  [/^minimax-h3-max-recast$/, { minSeconds: 5, maxSeconds: 30 }],
  [/^kling-v3-(standard|pro)-motion-control$/, { minSeconds: 3, maxSeconds: 30 }],
  [/^wan-2-7-video-to-video$/, { minSeconds: 2, maxSeconds: 10 }],
];

/**
 * Character image of Venice's motion-control models: they take it as
 * `image_url`, not as reference images. Venice's validation does not reject
 * an unused `image_url`, so this can't be asked of Venice.
 */
const CHARACTER_IMAGE_MODELS = /^kling-v3-(standard|pro)-motion-control$/;

/** Whether a Venice model takes reference images (`reference_image_urls`). */
export type VeniceReferenceImages = 'required' | 'optional' | 'none';

/** How the seller handles a Venice video-to-video model (`video_input`). */
export interface VeniceEditRule {
  minSeconds?: number;
  maxSeconds?: number;
  /**
   * Fields Venice requires besides `video_url`, checked before payment
   * because Venice's own refusal comes after the payment channel opened.
   * Measured on 2026-10-23: Recast requires `reference_image_urls`; motion
   * control, Wan, Gemini Omni and HappyHorse require `prompt`.
   */
  required: string[];
  /**
   * The model lists only `Auto` durations: the output is as long as the
   * source, and Venice wants the source length as `duration`. That value is
   * also what the buyer pays for, so it must match the source.
   */
  outputFollowsSource: boolean;
}

const veniceConstraints = (model: unknown) =>
  (model as { model_spec?: { constraints?: Record<string, unknown> } } | null)?.model_spec?.constraints;

/** The seller's handling of a Venice video-to-video model, or null for other models. */
export function veniceEditRule(model: unknown): VeniceEditRule | null {
  const constraints = veniceConstraints(model);
  if (!constraints || constraints.video_input !== true) return null;
  const id = (model as { id?: unknown }).id;
  const limits = typeof id === 'string' ? KNOWN_SOURCE_SECONDS.find(([pattern]) => pattern.test(id))?.[1] : undefined;
  const durations = constraints.durations;
  const outputFollowsSource = Array.isArray(durations) && durations.length > 0 && durations.every(value => typeof value === 'string' && value.toLowerCase() === 'auto');
  const required = typeof id === 'string' ? KNOWN_REQUIRED_FIELDS.find(([pattern]) => pattern.test(id))?.[1] ?? ['prompt'] : ['prompt'];
  return { ...limits, required: [...required], outputFollowsSource };
}

/** Fields Venice's video-to-video models require besides `video_url` (see VeniceEditRule.required). */
const KNOWN_REQUIRED_FIELDS: Array<[RegExp, readonly string[]]> = [
  [/^minimax-h3-max-recast$/, ['reference_image_urls']],
];

/**
 * Video options of a Venice video-to-video model: it takes and requires the
 * source video, and the character or reference images it takes. Options the
 * seller configured are kept.
 */
export function veniceEditCapabilities(capabilities: ServiceCapabilities, model: unknown, references: VeniceReferenceImages | null, rule: VeniceEditRule): ServiceCapabilities {
  const id = (model as { id?: unknown } | null)?.id;
  const characterImage = typeof id === 'string' && CHARACTER_IMAGE_MODELS.test(id);
  const kinds: VideoInputKind[] = ['video', ...(references === 'required' || references === 'optional' || characterImage ? ['reference_image' as const] : [])];
  const required: VideoInputKind[] = ['video', ...(references === 'required' ? ['reference_image' as const] : [])];
  const configured = capabilities.video ?? {};
  // Case-sensitive, as Venice lists them (`768P` for Recast, `720p` for Wan).
  const listed = veniceConstraints(model)?.resolutions;
  const resolutions = Array.isArray(listed) && listed.length > 0 && listed.length <= 16
    && listed.every(value => typeof value === 'string' && value.length > 0 && value.length <= 32)
    ? [...listed as string[]]
    : undefined;
  const durations = rule.outputFollowsSource && rule.minSeconds !== undefined && rule.maxSeconds !== undefined
    ? Array.from({ length: rule.maxSeconds - rule.minSeconds + 1 }, (_, i) => rule.minSeconds! + i)
    : [];
  return {
    ...capabilities,
    video: {
      ...configured,
      inputs: configured.inputs ? [...configured.inputs, ...kinds.filter(kind => !configured.inputs!.includes(kind))] : kinds,
      requiredInputs: configured.requiredInputs ?? required,
      ...(!configured.durationsSeconds && durations.length > 0 ? { durationsSeconds: durations } : {}),
      ...(!configured.resolutions && resolutions ? { resolutions } : {}),
    },
  };
}

/**
 * Whether a Venice video-to-video model takes reference images, or null when
 * Venice's answer does not say. Free: the create is invalid on purpose
 * (impossible duration, empty prompt, no source), so Venice rejects it with
 * `400` and lists each problem. With an empty `reference_image_urls`, Venice
 * says "At least one reference is required" for a model that needs them,
 * "does not support reference images" for one that takes none, and nothing
 * about the field for one that takes them optionally.
 */
export async function veniceReferenceImages(baseUrl: string, apiKey: string, model: string): Promise<VeniceReferenceImages | null> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/video/queue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', duration: END_FRAME_CHECK_DURATION, reference_image_urls: [] }),
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const details = response.status === 400 && body.length <= MAX_STATUS_BYTES ? parseJsonObject(body)?.details : null;
    if (!details || typeof details !== 'object' || !('duration' in details)) return null;
    const errors = (details as Record<string, { _errors?: unknown }>).reference_image_urls?._errors;
    const messages = Array.isArray(errors) ? errors.filter((message): message is string => typeof message === 'string') : [];
    if (messages.some(message => /not support/i.test(message))) return 'none';
    if (messages.some(message => /required/i.test(message))) return 'required';
    return messages.length === 0 ? 'optional' : null;
  } catch {
    return null;
  }
}

/**
 * Queue fields a Venice model takes, from its `/models` constraints. Frame
 * fields follow the seller's announced `video.inputs`; without them an
 * image-to-video model takes `image_url`, plus `end_image_url` when
 * `endFrame` is true (Venice's model list does not say, see veniceAcceptsEndFrame).
 */
export function veniceInputParameters(model: unknown, inputs?: readonly string[], endFrame = false): string[] | null {
  const constraints = veniceConstraints(model);
  if (!constraints || typeof constraints !== 'object') return null;
  const id = (model as { id?: unknown }).id;
  const edit = constraints.video_input === true;
  // In a video-to-video model an image is the new character, not the opening frame.
  const characterImage = edit && typeof id === 'string' && CHARACTER_IMAGE_MODELS.test(id);
  const frames = edit
    ? (inputs?.includes('reference_image') ? [characterImage ? 'image_url' : FRAME_FIELDS.reference_image] : [])
    : inputs
      ? Object.entries(FRAME_FIELDS).filter(([input]) => inputs.includes(input)).map(([, field]) => field)
      : constraints.model_type === 'image-to-video'
        ? [FRAME_FIELDS.first_frame, ...(endFrame ? [FRAME_FIELDS.last_frame] : [])]
        : [];
  const parameters = [
    'prompt',
    'duration',
    ...(edit ? ['video_url'] : []),
    ...(Array.isArray(constraints.resolutions) && constraints.resolutions.length > 0 ? ['resolution'] : []),
    ...(Array.isArray(constraints.aspect_ratios) && constraints.aspect_ratios.length > 0 ? ['aspect_ratio'] : []),
    ...(constraints.audio_configurable === true ? ['audio'] : []),
    ...frames,
  ].sort();
  return validateServiceCapabilityFields({ supportedParameters: parameters }).length === 0 ? parameters : null;
}

/**
 * Whether a Venice model accepts a last frame (`end_image_url`), or null when
 * Venice's answer does not say. Free: the create is invalid on purpose (empty
 * prompt, impossible duration), so Venice rejects it with `400` and lists each
 * problem, naming `end_image_url` when the model does not support it. Any
 * other answer is treated as unknown.
 */
export async function veniceAcceptsEndFrame(baseUrl: string, apiKey: string, model: string): Promise<boolean | null> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/video/queue`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, prompt: '', duration: END_FRAME_CHECK_DURATION, end_image_url: END_FRAME_CHECK_IMAGE }),
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    const body = Buffer.from(await response.arrayBuffer());
    const details = response.status === 400 && body.length <= MAX_STATUS_BYTES ? parseJsonObject(body)?.details : null;
    if (!details || typeof details !== 'object' || !('duration' in details)) return null;
    const errors = (details as Record<string, { _errors?: unknown }>).end_image_url?._errors;
    return !(Array.isArray(errors) && errors.some(message => typeof message === 'string' && /not support/i.test(message)));
  } catch {
    return null;
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

type VeniceAccount =
  | { status: 'ok'; balanceUsd: number }
  | { status: 'unavailable'; reason: string }
  | { status: 'unknown'; reason: string };

/**
 * Read the key's account state from Venice's free rate-limits endpoint. The
 * balance adds the USD, DIEM (1 DIEM buys $1 of inference a day) and bundled
 * credit balances.
 */
async function readVeniceAccount(baseUrl: string, apiKey: string): Promise<VeniceAccount> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/api_keys/rate_limits`, {
      headers: { authorization: `Bearer ${apiKey}` },
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { status: 'unavailable', reason: `Venice rejected the API key (HTTP ${response.status})` };
    }
    if (!response.ok) return { status: 'unknown', reason: `Venice account check returned HTTP ${response.status}` };
    const data = (parseJsonObject(Buffer.from(await response.arrayBuffer()))?.data ?? null) as
      { accessPermitted?: unknown; balances?: Record<string, unknown> } | null;
    if (!data || typeof data !== 'object') return { status: 'unknown', reason: 'Venice account check returned no data' };
    if (data.accessPermitted === false) return { status: 'unavailable', reason: 'Venice API access is not permitted for this key' };
    const balances = Object.values(data.balances ?? {}).filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (balances.length === 0) return { status: 'unknown', reason: 'Venice account check returned no balance' };
    return { status: 'ok', balanceUsd: balances.reduce((sum, value) => sum + value, 0) };
  } catch (cause) {
    return { status: 'unknown', reason: `Venice account check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/**
 * Venice's public video model list, ID → listed. Reading it costs nothing
 * and does not count against the key's video request limit, unlike a
 * request to each model. Returns null when the list can't be read.
 */
async function readVeniceVideoModels(baseUrl: string): Promise<Set<string> | null> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/models?type=video`, {
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const data = parseJsonObject(Buffer.from(await response.arrayBuffer()))?.data;
    if (!Array.isArray(data)) return null;
    const models = new Set<string>();
    for (const model of data as Array<{ id?: unknown }>) {
      if (typeof model?.id === 'string') models.add(model.id);
    }
    return models.size > 0 ? models : null;
  } catch {
    return null;
  }
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
    {
      key: 'VENICE_VIDEO_MIN_BALANCE_USD',
      label: 'Minimum Balance (USD)',
      type: 'number',
      default: 0,
      description: 'Stop advertising video models while the Venice balance is at or below this amount',
    },
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
    const minBalanceUsd = Number(config['VENICE_VIDEO_MIN_BALANCE_USD'] ?? 0);
    if (!Number.isFinite(minBalanceUsd) || minBalanceUsd < 0) throw new Error('VENICE_VIDEO_MIN_BALANCE_USD must be a non-negative number');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const serviceCapabilities: Record<string, ServiceCapabilities> = Object.fromEntries(
      services.map(service => [service, { ...configuredCapabilities?.[service], outputs: ['video'] }]),
    );
    const relay = new BaseProvider({
      name: 'venice-video',
      services,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: Object.fromEntries(services.map(service => [service, [PROTOCOL]])),
      serviceUnitBillingModels,
      serviceCapabilities,
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

    // Video-to-video models: checked before payment.
    const editRules = new Map<string, VeniceEditRule>();
    // Models Venice lists without video input: a source video there is ignored or refused after payment.
    const noVideoInput = new Set<string>();
    const precheckSource = createVideoSourcePrecheck();

    // Announces the queue fields each model takes, so buyers send only those.
    const init = async () => {
      try {
        const response = await fetch(`${baseUrl}/api/v1/models?type=video`, {
          headers: { authorization: `Bearer ${apiKey}` },
          redirect: 'error',
          signal: AbortSignal.timeout(10_000),
        });
        const body = Buffer.from(await response.arrayBuffer());
        const data = response.ok && body.length <= MAX_MODELS_BYTES ? parseJsonObject(body)?.data : null;
        if (!Array.isArray(data)) return;
        let checks = 0;
        for (const service of services) {
          const model = data.find(entry => entry?.id === service);
          const rule = veniceEditRule(model);
          if (model && !rule) noVideoInput.add(service);
          if (rule) {
            editRules.set(service, rule);
            const configured = serviceCapabilities[service]!.video;
            // Reference images the seller did not announce: ask Venice whether this model takes them.
            let references: VeniceReferenceImages | null = null;
            if (!configured?.inputs) {
              if (checks++ > 0) await new Promise(resolve => setTimeout(resolve, END_FRAME_CHECK_INTERVAL_MS));
              references = await veniceReferenceImages(baseUrl, apiKey, service);
            }
            serviceCapabilities[service] = veniceEditCapabilities(serviceCapabilities[service]!, model, references, rule);
          }
          const capabilities = serviceCapabilities[service]!;
          if (capabilities.supportedParameters) continue;
          // Frames the seller did not announce: ask Venice whether this image-to-video model takes a last frame.
          let endFrame = false;
          if (!rule && !capabilities.video?.inputs && model?.model_spec?.constraints?.model_type === 'image-to-video') {
            if (checks++ > 0) await new Promise(resolve => setTimeout(resolve, END_FRAME_CHECK_INTERVAL_MS));
            endFrame = await veniceAcceptsEndFrame(baseUrl, apiKey, service) === true;
          }
          const parameters = veniceInputParameters(model, capabilities.video?.inputs, endFrame);
          if (parameters) capabilities.supportedParameters = parameters;
        }
      } catch {
        // Unknown model fields: buyers fall back to their defaults.
      }
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
      if (response.statusCode === 413) {
        // Venice answers an oversized body with an HTML page.
        return error(request, 413, 'request_too_large', `Venice accepts request bodies up to ${VENICE_MAX_BODY_BYTES / 1_000_000} MB; send a smaller file or a public https URL`);
      }
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
      serviceCapabilities,
      maxConcurrency,
      getCapacity: () => relay.getCapacity(),
      init,
      handleRequest,
      async precheckRequest(request, { buyerPeerId }) {
        if (nativeVideoRoute(request)?.action !== 'create') return null;
        if (request.body.length > VENICE_MAX_BODY_BYTES) {
          return error(request, 413, 'request_too_large',
            `This request is ${(request.body.length / 1_000_000).toFixed(1)} MB; Venice accepts up to ${VENICE_MAX_BODY_BYTES / 1_000_000} MB. Send a smaller file or a public https URL`);
        }
        const { service } = route(request);
        const rule = service ? editRules.get(service) : undefined;
        if (!rule) {
          if (service && noVideoInput.has(service) && request.body.length > 0) {
            const body = parseJsonObject(request.body);
            if (body && body.video_url !== undefined && body.video_url !== null) {
              return error(request, 400, 'unsupported_parameter', `${service} does not take video_url; pick a video-to-video model`);
            }
          }
          return null;
        }
        const body = parseJsonObject(request.body);
        if (!body) return null;
        const source = body.video_url;
        if (source === undefined || source === null) return error(request, 400, 'missing_required_field', 'This model requires video_url');
        const required = [...rule.required];
        // A model the seller announced as needing reference images needs them, whatever Venice's list says.
        if (serviceCapabilities[service!]?.video?.requiredInputs?.includes('reference_image') && !CHARACTER_IMAGE_MODELS.test(service!) && !required.includes('reference_image_urls')) {
          required.push('reference_image_urls');
        }
        const missing = required.filter(field => {
          const value = body[field];
          return value === undefined || value === null || (typeof value === 'string' && value.trim() === '') || (Array.isArray(value) && value.length === 0);
        });
        if (missing.length > 0) return error(request, 400, 'missing_required_field', `This model requires ${missing.join(', ')}`);
        // Motion control reads the character from image_url; without it the job fails after payment.
        if (CHARACTER_IMAGE_MODELS.test(service!) && (typeof body.image_url !== 'string' || body.image_url === '')) {
          return error(request, 400, 'missing_required_field', 'This model requires image_url (the character image)');
        }
        if (typeof source !== 'string') return error(request, 400, 'invalid_video_source', 'video_url must be a string');
        let declared: number | undefined;
        try {
          declared = nativeVideoFacts(request)?.duration;
        } catch {
          return null;
        }
        return precheckSource(request, buyerPeerId, source, declared, {
          ...(rule.minSeconds !== undefined ? { minSeconds: rule.minSeconds } : {}),
          ...(rule.maxSeconds !== undefined ? { maxSeconds: rule.maxSeconds } : {}),
          // Venice refuses "Auto" for these models and needs the source length.
          durationMatchesSource: rule.outputFollowsSource && body.duration !== undefined,
        });
      },
      async checkServiceHealth(checked) {
        const models = await readVeniceVideoModels(baseUrl);
        return Object.fromEntries(checked.map((service): [string, ServiceHealthStatus] => {
          if (!models) return [service, { status: 'unknown', reason: 'Venice model list unavailable' }];
          if (!models.has(service)) return [service, { status: 'unavailable', reason: 'Venice no longer offers this model' }];
          return [service, { status: 'available' }];
        }));
      },
      async checkUpstreamAccount(): Promise<UpstreamAccountStatus> {
        const account = await readVeniceAccount(baseUrl, apiKey);
        if (account.status !== 'ok') return account;
        if (account.balanceUsd <= minBalanceUsd) {
          return { status: 'unavailable', reason: `Venice balance $${account.balanceUsd.toFixed(2)} is at or below the $${minBalanceUsd} minimum` };
        }
        return { status: 'available', balanceUsd: account.balanceUsd };
      },
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
          const failed = terminalRetrieveFailure(upstream.status, body);
          if (failed) {
            console.warn(`[venice-video] job ${videoRoute.resourceId} failed: ${failed}`);
            return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }, body: Buffer.from(JSON.stringify({ status: 'FAILED', error: failed })) };
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

/**
 * Venice answers retrieve for a job it rejected (for example motion control
 * without a person in the source) with a JSON 400 or 422 instead of a FAILED
 * status. That answer is final, so it becomes FAILED: the buyer stops polling
 * and the seller closes the job's channel instead of holding the reserve.
 * Returns the reason, or null when the answer is not a terminal refusal.
 */
export function terminalRetrieveFailure(status: number, body: Uint8Array): string | null {
  if (status !== 400 && status !== 422) return null;
  const parsed = parseJsonObject(Buffer.from(body));
  if (!parsed) return null;
  const detail = parsed.details ?? parsed.detail;
  const reasons = [parsed.message, parsed.error, typeof detail === 'string' ? detail : undefined]
    .map(value => (typeof value === 'object' && value !== null ? (value as { message?: unknown }).message : value))
    .filter((value): value is string => typeof value === 'string' && value.trim() !== '');
  return reasons[0]?.slice(0, 500) ?? `Venice answered HTTP ${status} with no reason`;
}

export default plugin;

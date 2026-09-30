import type { Provider, SerializedHttpRequest, SerializedHttpResponse, ServiceCapabilities } from '@antseed/node';

type VideoOptions = NonNullable<ServiceCapabilities['video']>;
type VideoInputKind = NonNullable<VideoOptions['inputs']>[number];
import { nativeVideoRoute, parseJsonObject, requestService } from '@antseed/api-adapter';

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string' && /^[A-Za-z0-9:._-]{1,32}$/.test(item)))] : [];
}

const AUTO_DURATIONS = new Set(['auto', 'Auto', '-1', '1 gen']);

export function veniceVideoOptionError(request: SerializedHttpRequest, options: VideoOptions | undefined): string | null {
  const route = nativeVideoRoute(request);
  if (route?.action !== 'create' || !options) return null;
  const body = parseJsonObject(request.body);
  if (!body) return 'Video submission requires a JSON object';
  const duration = veniceDuration(body.duration);
  if (options.durationsSeconds && (duration === null || (duration !== undefined && !options.durationsSeconds.includes(duration)))) {
    return `Unsupported duration; choose one of ${options.durationsSeconds.join(', ')} seconds`;
  }
  const resolution = unsupportedChoice(body.resolution, options.resolutions, 'resolution');
  if (resolution) return resolution;
  const aspectRatio = unsupportedChoice(body.aspect_ratio, options.aspectRatios, 'aspect ratio');
  if (aspectRatio) return aspectRatio;
  const inputs = veniceInputs(body);
  const unsupported = options.inputs ? inputs.find(input => !options.inputs!.includes(input)) : undefined;
  if (unsupported) return `Unsupported video input ${unsupported}`;
  const missing = options.requiredInputs?.find(input => !inputs.includes(input));
  if (missing) return `Missing required video input ${missing}`;
  if (body.audio === true && options.audio === false) return 'This model does not generate audio';
  return null;
}

function unsupportedChoice(value: unknown, supported: string[] | undefined, label: string): string | null {
  return value !== undefined && supported && (typeof value !== 'string' || !supported.some(item => item.toLowerCase() === value.toLowerCase()))
    ? `Unsupported ${label}; choose one of ${supported.join(', ')}`
    : null;
}

function veniceInputs(body: JsonObject): VideoInputKind[] {
  return [...new Set<VideoInputKind>([
    ...(body.image_url ? ['first_frame' as const] : []),
    ...(body.end_image_url ? ['last_frame' as const] : []),
    ...(Array.isArray(body.reference_image_urls) && body.reference_image_urls.length ? ['reference_image' as const] : []),
    ...(body.video_url ? ['video' as const] : []),
    ...(Array.isArray(body.reference_video_urls) && body.reference_video_urls.length ? ['reference_video' as const] : []),
    ...(body.audio_url || (Array.isArray(body.reference_audio_urls) && body.reference_audio_urls.length) ? ['audio' as const] : []),
  ])];
}

function veniceDuration(value: unknown): number | undefined | null {
  if (value === undefined || (typeof value === 'string' && AUTO_DURATIONS.has(value))) return undefined;
  const normalized = typeof value === 'string' ? value.trim().replace(/s$/, '') : value;
  const parsed = typeof normalized === 'string' && /^[0-9]+$/.test(normalized) ? Number(normalized) : normalized;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Venice model constraints use a model-specific shape; convert only the fields we can enforce. */
export function veniceVideoOptions(model: unknown): VideoOptions | undefined {
  const entry = object(model);
  const constraints = object(object(entry.model_spec).constraints);
  const type = constraints.model_type;
  const id = typeof entry.id === 'string' ? entry.id : '';
  const durationsSeconds = strings(constraints.durations).flatMap(value => /^[1-9][0-9]*s$/.test(value) ? [Number(value.slice(0, -1))] : []);
  const resolutions = strings(constraints.resolutions);
  const aspectRatios = strings(constraints.aspect_ratios).filter(value => !['auto', 'adaptive'].includes(value.toLowerCase()));
  const inputs: VideoInputKind[] = [];
  const requiredInputs: VideoInputKind[] = [];
  if (type === 'image-to-video') {
    if (id.includes('reference-to-video')) {
      inputs.push('reference_image');
      requiredInputs.push('reference_image');
    } else {
      inputs.push('first_frame', 'last_frame');
      requiredInputs.push('first_frame');
    }
  }
  if (constraints.video_input === true) inputs.push('video', 'reference_video');
  if (constraints.audio_input === true) inputs.push('audio');
  if (type === 'video' && constraints.video_input === true) requiredInputs.push('video');
  const options: VideoOptions = {
    ...(durationsSeconds.length ? { durationsSeconds } : {}),
    ...(resolutions.length ? { resolutions } : {}),
    ...(aspectRatios.length ? { aspectRatios } : {}),
    ...(type === 'text-to-video' || type === 'image-to-video' || type === 'video' ? { inputs } : {}),
    ...(requiredInputs.length ? { requiredInputs } : {}),
    ...(typeof constraints.audio === 'boolean' ? { audio: constraints.audio } : {}),
  };
  return Object.keys(options).length ? options : undefined;
}

/**
 * Adds Venice's published video constraints to configured services.
 * Explicit seller settings win, and unknown models keep their existing capabilities.
 */
export function withVeniceModelOptions(provider: Provider, baseUrl: string, apiKey: string): Provider {
  const optionError = (request: SerializedHttpRequest): SerializedHttpResponse | null => {
    const service = requestService(request);
    const message = service ? veniceVideoOptionError(request, wrapped.serviceCapabilities?.[service]?.video) : null;
    return message ? { requestId: request.requestId, statusCode: 400, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ error: { code: 'unsupported_video_options', message } })) } : null;
  };
  const wrapped: Provider = {
    ...provider,
    async handleRequest(request) {
      return optionError(request) ?? provider.handleRequest(request);
    },
    ...(provider.handleRequestStream ? {
      async handleRequestStream(request, callbacks) {
        return optionError(request) ?? provider.handleRequestStream!(request, callbacks);
      },
    } : {}),
    async init() {
      await provider.init?.();
      const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/api/v1/models?type=video`, {
        headers: { authorization: `Bearer ${apiKey}` }, redirect: 'error', signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Could not load Venice video models (${response.status})`);
      const models = object(await response.json()).data;
      const byId = new Map((Array.isArray(models) ? models : []).flatMap(model => {
        const id = object(model).id;
        return typeof id === 'string' ? [[id, veniceVideoOptions(model)] as const] : [];
      }));
      const serviceCapabilities = { ...wrapped.serviceCapabilities };
      for (const service of provider.services) {
        const video = byId.get(service);
        if (!video || serviceCapabilities[service]?.video) continue;
        serviceCapabilities[service] = { ...serviceCapabilities[service], video };
      }
      wrapped.serviceCapabilities = serviceCapabilities;
    },
  };
  return wrapped;
}

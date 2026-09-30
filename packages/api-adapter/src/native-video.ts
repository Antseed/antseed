import type { NativeVideoProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, parseJsonObject } from './utils.js';

export type { NativeVideoProtocol };

export interface NativeVideoRoute {
  protocol: NativeVideoProtocol;
  action: 'create' | 'download';
  resourceId?: string;
}

type JsonObject = Record<string, unknown>;

interface VideoRequestFields {
  duration?: unknown;
  resolution?: unknown;
  aspectRatio?: unknown;
  audio?: unknown;
}

export type VideoInputKind = 'first_frame' | 'last_frame' | 'reference_image' | 'video' | 'reference_video' | 'audio';

/** Same shape as `ServiceCapabilities.video` in `@antseed/protocol`. */
export interface VideoOptions {
  durationsSeconds?: number[];
  resolutions?: string[];
  aspectRatios?: string[];
  inputs?: VideoInputKind[];
  requiredInputs?: VideoInputKind[];
  audio?: boolean;
}

const VENICE_CREATE_PATH = '/api/v1/video/queue';
const VENICE_DOWNLOAD_PATH = '/api/v1/video/retrieve';
const VENICE_QUEUE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const VENICE_AUTO_DURATIONS = new Set(['auto', 'Auto', '-1', '1 gen']);

export function detectNativeVideoProtocol(path: string): NativeVideoProtocol | null {
  const normalizedPath = normalizedRequestPath(path);
  return normalizedPath === VENICE_CREATE_PATH || normalizedPath === VENICE_DOWNLOAD_PATH ? 'venice-video' : null;
}

/**
 * Classifies a native video request. Pass the body for APIs that carry the job
 * ID in it; without a body such follow-ups are still recognised but have no
 * `resourceId`, which callers treat as an unknown job.
 */
export function nativeVideoRoute(request: Pick<SerializedHttpRequest, 'path' | 'method'> & { body?: Uint8Array }): NativeVideoRoute | null {
  if (request.method !== 'POST') return null;
  const path = normalizedRequestPath(request.path);
  if (path === VENICE_CREATE_PATH) return { protocol: 'venice-video', action: 'create' };
  if (path !== VENICE_DOWNLOAD_PATH) return null;
  const resourceId = request.body ? veniceQueueId(parseJsonObject(request.body)) : null;
  return { protocol: 'venice-video', action: 'download', ...(resourceId ? { resourceId } : {}) };
}

/** Job ID from a successful create response, or null when the seller did not accept a job. */
export function nativeVideoAcceptance(protocol: NativeVideoProtocol, response: SerializedHttpResponse): string | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const body = parseJsonObject(response.body);
  if (!body || body.error) return null;
  return protocol === 'venice-video' ? veniceQueueId(body) : null;
}

export function requestService(request: SerializedHttpRequest): string | undefined {
  const route = nativeVideoRoute(request);
  if (route && route.action !== 'create') {
    const header = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'x-antseed-service')?.[1];
    return header?.trim() || undefined;
  }
  const body = extractRequestBodyFields(request.headers, request.body);
  if (route) {
    return typeof body?.model === 'string' && body.model.length > 0 ? body.model : undefined;
  }
  const service = body?.service ?? body?.model;
  if (typeof service === 'string' && service.trim()) return service.trim();
  return undefined;
}

export interface NativeVideoFacts {
  protocol: NativeVideoProtocol;
  action: NativeVideoRoute['action'];
  count: number;
  duration?: number;
  resolution?: string;
}

export function nativeVideoFacts(request: SerializedHttpRequest): NativeVideoFacts | undefined {
  const route = nativeVideoRoute(request);
  if (!route) return undefined;
  if (route.action !== 'create') return { protocol: route.protocol, action: route.action, count: 0 };
  const body = parseJsonObject(request.body);
  if (!body) throw new Error('Video submission requires a JSON object');
  const fields = veniceFields(body);
  const count = 1;
  const duration = veniceDuration(fields.duration);
  if (duration === null) throw new Error('Video duration must be a positive integer');
  if (duration !== undefined && !Number.isSafeInteger(duration * count)) throw new Error('Video quantity exceeds the safe integer limit');
  return {
    protocol: route.protocol, action: route.action, count,
    ...(duration === undefined ? {} : { duration }),
    ...(typeof fields.resolution === 'string' ? { resolution: fields.resolution } : {}),
  };
}

/**
 * Returns the first create setting the model does not advertise. Only
 * advertised lists are enforced: an absent list means the seller did not
 * describe that option, so the upstream remains the authority.
 */
export function nativeVideoOptionError(request: SerializedHttpRequest, options: VideoOptions | undefined): string | null {
  const route = nativeVideoRoute(request);
  if (!route || route.action !== 'create' || !options) return null;
  const body = parseJsonObject(request.body);
  if (!body) return 'Video submission requires a JSON object';
  const fields = veniceFields(body);
  const inputs = [...new Set(veniceInputs(body))];
  const duration = veniceDuration(fields.duration);
  if (options.durationsSeconds && (duration === null || (duration !== undefined && !options.durationsSeconds.includes(duration)))) {
    return `Unsupported duration; choose one of ${options.durationsSeconds.join(', ')} seconds`;
  }
  const choice = (value: unknown, supported: string[] | undefined, label: string) => (
    value !== undefined && supported && (typeof value !== 'string' || !supported.some(item => item.toLowerCase() === value.toLowerCase()))
      ? `Unsupported ${label}; choose one of ${supported.join(', ')}`
      : null
  );
  const resolution = choice(fields.resolution, options.resolutions, 'resolution');
  if (resolution) return resolution;
  const aspectRatio = choice(fields.aspectRatio, options.aspectRatios, 'aspect ratio');
  if (aspectRatio) return aspectRatio;
  if (options.inputs) {
    const unsupported = inputs.find(input => !options.inputs!.includes(input));
    if (unsupported) return `Unsupported video input ${unsupported}`;
  }
  const missing = options.requiredInputs?.find(input => !inputs.includes(input));
  if (missing) return `Missing required video input ${missing}`;
  if (fields.audio === true && options.audio === false) return 'This model does not generate audio';
  return null;
}

function normalizedRequestPath(path: string): string {
  return path.split('?')[0] ?? '';
}

function veniceQueueId(body: JsonObject | null): string | null {
  const queueId = body?.queue_id;
  return typeof queueId === 'string' && VENICE_QUEUE_ID.test(queueId) ? queueId : null;
}

function veniceFields(body: JsonObject): VideoRequestFields {
  return {
    duration: typeof body.duration === 'string' ? body.duration.replace(/s$/, '') : body.duration,
    resolution: body.resolution,
    aspectRatio: body.aspect_ratio,
    audio: body.audio,
  };
}

function veniceInputs(body: JsonObject): VideoInputKind[] {
  return [
    ...(body.image_url ? ['first_frame' as const] : []),
    ...(body.end_image_url ? ['last_frame' as const] : []),
    ...(Array.isArray(body.reference_image_urls) && body.reference_image_urls.length ? ['reference_image' as const] : []),
    ...(body.video_url ? ['video' as const] : []),
    ...(Array.isArray(body.reference_video_urls) && body.reference_video_urls.length ? ['reference_video' as const] : []),
    ...(body.audio_url || (Array.isArray(body.reference_audio_urls) && body.reference_audio_urls.length) ? ['audio' as const] : []),
  ];
}

function veniceDuration(value: unknown): number | undefined | null {
  return typeof value === 'string' && VENICE_AUTO_DURATIONS.has(value) ? undefined : positiveInteger(value);
}

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

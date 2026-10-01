import type { NativeVideoProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, parseJsonObject } from './utils.js';

export type { NativeVideoProtocol };

export interface NativeVideoRoute {
  protocol: NativeVideoProtocol;
  action: 'create' | 'retrieve';
  resourceId?: string;
}

type JsonObject = Record<string, unknown>;

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
  return { protocol: 'venice-video', action: 'retrieve', ...(resourceId ? { resourceId } : {}) };
}

/** Job ID from a successful create response, or null when the seller did not accept a job. */
export function nativeVideoAcceptance(protocol: NativeVideoProtocol, response: SerializedHttpResponse): string | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const body = parseJsonObject(response.body);
  if (!body || body.error) return null;
  return protocol === 'venice-video' ? veniceQueueId(body) : null;
}

/**
 * True when a retrieve response hands the finished video to the buyer: a
 * completed streamed MP4 download, or Venice's JSON `COMPLETED` status for
 * private models that deliver through their own download URL.
 */
/** Share of the requested duration a delivered video must reach (models round). */
export const VIDEO_MIN_DURATION_RATIO = 0.9;

/**
 * Whether a retrieve response delivered the finished video, so its price may
 * be charged. Only a streamed download counts, and only when it is a complete
 * MP4 (`video/mp4`, starts with `ftyp`, readable duration) at least
 * VIDEO_MIN_DURATION_RATIO of the requested seconds long. JSON status answers
 * never count; the seller streams private-model files from their download URL.
 */
export function nativeVideoDelivered(response: SerializedHttpResponse, requestedDurationSeconds?: number): boolean {
  if (response.statusCode !== 200 || !response.streamedBody) return false;
  const contentType = Object.entries(response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  const durationMs = response.streamedBody.videoDurationMs;
  if (!contentType?.toLowerCase().startsWith('video/mp4') || durationMs === undefined) return false;
  return !requestedDurationSeconds || durationMs >= requestedDurationSeconds * 1000 * VIDEO_MIN_DURATION_RATIO;
}

export function requestService(request: SerializedHttpRequest): string | undefined {
  const route = nativeVideoRoute(request);
  if (route?.action === 'retrieve') {
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
  if (route.action === 'retrieve') return { protocol: route.protocol, action: route.action, count: 0 };
  const body = parseJsonObject(request.body);
  if (!body) throw new Error('Video submission requires a JSON object');
  const count = 1;
  const duration = veniceDuration(body.duration);
  if (duration === null) throw new Error('Video duration must be a positive integer');
  if (duration !== undefined && !Number.isSafeInteger(duration * count)) throw new Error('Video quantity exceeds the safe integer limit');
  return {
    protocol: route.protocol, action: route.action, count,
    ...(duration === undefined ? {} : { duration }),
    ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
  };
}

function normalizedRequestPath(path: string): string {
  return path.split('?')[0] ?? '';
}

function veniceQueueId(body: JsonObject | null): string | null {
  const queueId = body?.queue_id;
  return typeof queueId === 'string' && VENICE_QUEUE_ID.test(queueId) ? queueId : null;
}

function veniceDuration(value: unknown): number | undefined | null {
  if (typeof value === 'string' && VENICE_AUTO_DURATIONS.has(value)) return undefined;
  return positiveInteger(typeof value === 'string' ? value.replace(/s$/, '') : value);
}

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

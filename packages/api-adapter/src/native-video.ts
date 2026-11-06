import { componentMatchesAttributes, type UnitBillingComponentV1, type UnitBillingMatchKeyV1 } from '@antseed/protocol/billing';
import type { NativeVideoProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, headerValue, parseJsonObject } from './utils.js';
import { inlineVideoSeconds } from './mp4.js';
import { inlineAudioSeconds } from './speech-audio.js';
import { dataServiceRoute } from './data-service.js';

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

/**
 * fal's own API puts the model in the URL. Antseed routes on the body `model`,
 * so fal video uses fixed paths with the fal endpoint ID as `model`; the
 * seller rebuilds fal's queue URLs from it.
 */
const FAL_CREATE_PATH = '/fal/v1/video/queue';
const FAL_DOWNLOAD_PATH = '/fal/v1/video/retrieve';
const FAL_REQUEST_ID = /^[A-Za-z0-9-]{1,128}$/;

const ROUTES: Record<string, NativeVideoRoute> = {
  [VENICE_CREATE_PATH]: { protocol: 'venice-video', action: 'create' },
  [VENICE_DOWNLOAD_PATH]: { protocol: 'venice-video', action: 'retrieve' },
  [FAL_CREATE_PATH]: { protocol: 'fal-video', action: 'create' },
  [FAL_DOWNLOAD_PATH]: { protocol: 'fal-video', action: 'retrieve' },
};

export function detectNativeVideoProtocol(path: string): NativeVideoProtocol | null {
  return ROUTES[normalizedRequestPath(path)]?.protocol ?? null;
}

/**
 * Classifies a native video request. Pass the body for APIs that carry the job
 * ID in it; without a body such follow-ups are still recognised but have no
 * `resourceId`, which callers treat as an unknown job.
 */
export function nativeVideoRoute(request: Pick<SerializedHttpRequest, 'path' | 'method'> & { body?: Uint8Array }): NativeVideoRoute | null {
  if (request.method !== 'POST') return null;
  const route = ROUTES[normalizedRequestPath(request.path)];
  if (!route || route.action === 'create') return route ? { ...route } : null;
  const resourceId = request.body ? jobId(route.protocol, parseJsonObject(request.body)) : null;
  return { ...route, ...(resourceId ? { resourceId } : {}) };
}

/** Job ID from a successful create response, or null when the seller did not accept a job. */
export function nativeVideoAcceptance(protocol: NativeVideoProtocol, response: SerializedHttpResponse): string | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const body = parseJsonObject(response.body);
  if (!body || body.error) return null;
  return jobId(protocol, body);
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
  const contentType = headerValue(response.headers, 'content-type');
  const durationMs = response.streamedBody.videoDurationMs;
  if (!contentType.toLowerCase().startsWith('video/mp4') || durationMs === undefined) return false;
  return !requestedDurationSeconds || durationMs >= requestedDurationSeconds * 1000 * VIDEO_MIN_DURATION_RATIO;
}

export function requestService(request: SerializedHttpRequest): string | undefined {
  const dataRoute = dataServiceRoute(request);
  if (dataRoute) return dataRoute.service;
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
  duration?: number;
  resolution?: string;
  aspectRatio?: string;
  /** Whether the create asks for audio: `audio`, or fal's `generate_audio`. */
  audio?: boolean;
  /** Whether the create sends reference videos (`reference_video_urls`, or fal's `video_urls`), for a create. */
  referenceVideo?: boolean;
}

/** Create fields that carry reference videos, by protocol. fal's own name is `video_urls`. */
export const REFERENCE_VIDEO_FIELDS: Record<NativeVideoProtocol, readonly string[]> = {
  'venice-video': ['reference_video_urls'],
  'fal-video': ['reference_video_urls', 'video_urls'],
};

/** The announced video options a create's price depends on (a subset of `VideoOptions`). */
export interface NativeVideoPricedOptions {
  aspectRatios?: readonly string[];
  audio?: boolean;
}

/**
 * The attributes a video create is priced by. A create that leaves out its
 * aspect ratio is priced at the service's first announced one, and one that
 * leaves out audio at the announced `video.audio`. Only Venice: its plugin sends
 * those values upstream, so the price is the clip's. Other protocols price what
 * the create names, so one leaving out a priced option matches no component.
 * `reference_video` is `"true"` or `"false"`: whether the create sends reference videos.
 */
export function nativeVideoAttributes(
  service: string,
  video: NativeVideoFacts,
  options: NativeVideoPricedOptions | undefined,
): Partial<Record<UnitBillingMatchKeyV1, string>> {
  const defaults = video.protocol === 'venice-video' ? options : undefined;
  const aspectRatio = video.aspectRatio ?? defaults?.aspectRatios?.[0];
  const audio = video.audio ?? defaults?.audio;
  return {
    model: service,
    ...(video.resolution ? { resolution: video.resolution } : {}),
    ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
    ...(audio !== undefined ? { audio: String(audio) } : {}),
    ...(video.referenceVideo !== undefined ? { reference_video: String(video.referenceVideo) } : {}),
  };
}

/**
 * Why a create's reference videos can't be served at the service's price, or
 * null. Upstreams bill reference videos on top of the output, so a create that
 * sends one needs a `reference_video: "true"` component whose every match
 * applies to it (a surcharge for 720p does not cover a 480p create). An
 * unreadable create is left to the other checks.
 */
export function referenceVideoPriceProblem(
  request: SerializedHttpRequest,
  service: string,
  components: readonly Pick<UnitBillingComponentV1, 'match'>[] | undefined,
  options?: NativeVideoPricedOptions,
  parsedBody?: Record<string, unknown> | null,
): string | null {
  let video: NativeVideoFacts | undefined;
  try {
    video = nativeVideoFacts(request, parsedBody);
  } catch {
    return null;
  }
  if (!video?.referenceVideo) return null;
  const attributes = nativeVideoAttributes(service, video, options);
  const priced = components?.some((component) => component.match?.reference_video === 'true'
    && componentMatchesAttributes(component, attributes));
  return priced ? null : 'This service does not take reference videos at these options';
}

/** Whether a create body sends at least one reference video. */
export function sendsReferenceVideo(protocol: NativeVideoProtocol, body: Record<string, unknown>): boolean {
  return REFERENCE_VIDEO_FIELDS[protocol].some((field) => {
    const value = body[field];
    return Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && value !== '';
  });
}

/**
 * The facts a video request is priced by. `parsedBody` is the request's body
 * when the caller already parsed it (null when it is not a JSON object), so a
 * large inline-media body is not parsed twice.
 */
export function nativeVideoFacts(request: SerializedHttpRequest, parsedBody?: Record<string, unknown> | null): NativeVideoFacts | undefined {
  const route = nativeVideoRoute(request);
  if (!route) return undefined;
  if (route.action === 'retrieve') return { protocol: route.protocol, action: route.action };
  const body = parsedBody === undefined ? parseJsonObject(request.body) : parsedBody;
  if (!body) throw new Error('Video submission requires a JSON object');
  const duration = route.protocol === 'fal-video' ? falDuration(body.duration) : veniceDuration(body.duration);
  if (duration === null) throw new Error('Video duration must be a positive integer');
  const audio = route.protocol === 'fal-video' ? body.generate_audio ?? body.audio : body.audio;
  return {
    protocol: route.protocol, action: route.action,
    ...(duration === undefined ? {} : { duration }),
    ...(typeof body.resolution === 'string' ? { resolution: body.resolution } : {}),
    ...(typeof body.aspect_ratio === 'string' ? { aspectRatio: body.aspect_ratio } : {}),
    ...(typeof audio === 'boolean' ? { audio } : {}),
    referenceVideo: sendsReferenceVideo(route.protocol, body),
  };
}

function normalizedRequestPath(path: string): string {
  return path.split('?')[0] ?? '';
}

function jobId(protocol: NativeVideoProtocol, body: JsonObject | null): string | null {
  if (protocol === 'fal-video') {
    const requestId = body?.request_id;
    return typeof requestId === 'string' && FAL_REQUEST_ID.test(requestId) ? requestId : null;
  }
  return veniceQueueId(body);
}

function veniceQueueId(body: JsonObject | null): string | null {
  const queueId = body?.queue_id;
  return typeof queueId === 'string' && VENICE_QUEUE_ID.test(queueId) ? queueId : null;
}

function veniceDuration(value: unknown): number | undefined | null {
  if (typeof value === 'string' && VENICE_AUTO_DURATIONS.has(value)) return undefined;
  return positiveInteger(typeof value === 'string' ? value.replace(/s$/, '') : value);
}

/** fal models take seconds as a number, `"5"` or `"5s"`. */
function falDuration(value: unknown): number | undefined | null {
  return positiveInteger(typeof value === 'string' ? value.trim().replace(/s$/, '') : value);
}

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Why a video edit can't go upstream, or null. The buyer pays for its
 * `duration`, but the upstream bills at least the whole source, and an output
 * cut short by the source is never charged (VIDEO_MIN_DURATION_RATIO). So the
 * source must be an inline video the seller can measure and `duration` its
 * length in whole seconds, rounded down (at least 1).
 */
export function videoSourceLengthProblem(videoUrl: unknown, duration: unknown): string | null {
  return sourceLengthProblem(
    inlineVideoSeconds(videoUrl),
    duration,
    'A video edit is paid by its source length: send the source inline as a regular (not fragmented) MP4 data:video/mp4;base64 URL, so the seller can measure its length',
  );
}

/**
 * Why a video whose length follows its input audio (a talking avatar) can't
 * go upstream, or null. The model takes no `duration`: its output is as long
 * as `audio_url`, and the upstream bills it by that length. So the audio must
 * be an inline MP3 or WAV the seller can measure, and the `duration` the
 * buyer pays for its length in whole seconds, rounded down (at least 1).
 */
export function audioSourceLengthProblem(audioUrl: unknown, duration: unknown): string | null {
  return sourceLengthProblem(
    inlineAudioSeconds(audioUrl),
    duration,
    'This model makes a video as long as its audio and is paid by that length: send audio_url inline as an MP3 or WAV data:audio/...;base64 URL, so the seller can measure its length',
  );
}

function sourceLengthProblem(seconds: number | null, duration: unknown, notMeasurable: string): string | null {
  if (seconds === null) return notMeasurable;
  const expected = Math.max(seconds, 1);
  const declared = typeof duration === 'string' ? Number(duration.trim().replace(/s$/, '')) : duration;
  return declared === expected ? null : `duration must be the source length in whole seconds, rounded down: ${expected}`;
}

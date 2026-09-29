import type { NativeVideoProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, parseJsonObject } from './utils.js';

export type { NativeVideoProtocol };

export interface NativeVideoRoute {
  protocol: NativeVideoProtocol;
  action: 'create' | 'status' | 'cancel' | 'download';
  resourceId?: string;
  /** Earlier jobs a create builds on (Seedance draft tasks). Invalid IDs are kept as '' so ownership checks fail. */
  referencedResourceIds?: string[];
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

/**
 * One entry per native video API. Everything provider-specific lives here:
 * paths, where the job ID sits in the accepted response, and which request
 * fields carry the billable quantity. Routing, ownership, idempotency and
 * billing elsewhere only use these descriptors.
 */
interface NativeVideoApi {
  protocol: NativeVideoProtocol;
  createPaths: RegExp;
  /** Status (GET) and cancel (DELETE) paths; the first capture group is the job ID. */
  jobPaths: { GET?: RegExp; DELETE?: RegExp };
  /**
   * Follow-ups that are POSTs carrying the job ID in the JSON body (Venice).
   * `download` answers with the finished MP4 itself, so it is streamed.
   */
  bodyJobPaths?: { path: RegExp; action: 'download' | 'cancel' }[];
  bodyJobId?: (body: JsonObject) => unknown;
  /** Earlier job IDs a create builds on; they only exist on the seller that ran them. */
  referencedJobs?: (body: JsonObject) => unknown[];
  jobId: (body: JsonObject) => unknown;
  jobIdPattern: RegExp;
  fields: (body: JsonObject) => VideoRequestFields;
  inputs: (body: JsonObject) => VideoInputKind[];
  /** Sentinel duration values meaning "let the model decide". */
  autoDuration?: unknown[];
}

const ID = '[A-Za-z0-9_-]+';
const SIMPLE_ID = /^[A-Za-z0-9_-]{1,256}$/;
function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

const NATIVE_VIDEO_APIS: NativeVideoApi[] = [
  {
    protocol: 'seedance-video',
    createPaths: /^\/api\/v3\/contents\/generations\/tasks$/,
    jobPaths: { GET: new RegExp(`^/api/v3/contents/generations/tasks/(${ID})$`), DELETE: new RegExp(`^/api/v3/contents/generations/tasks/(${ID})$`) },
    jobId: body => body.id,
    jobIdPattern: SIMPLE_ID,
    referencedJobs: body => (Array.isArray(body.content) ? body.content : [])
      .filter(item => object(item).type === 'draft_task')
      .map(item => object(object(item).draft_task).id),
    // `frames` overrides `duration`, so frame-based requests have no explicit seconds.
    fields: body => ({ duration: body.frames === undefined ? body.duration : undefined, resolution: body.resolution, aspectRatio: body.ratio, audio: body.generate_audio }),
    inputs: body => (Array.isArray(body.content) ? body.content : []).flatMap(item => {
      const content = object(item);
      if (content.type === 'image_url') return [content.role === 'last_frame' ? 'last_frame' as const : content.role === 'reference_image' ? 'reference_image' as const : 'first_frame' as const];
      if (content.type === 'video_url') return ['reference_video' as const];
      if (content.type === 'audio_url') return ['audio' as const];
      return [];
    }),
    autoDuration: [-1, '-1'],
  },
  {
    protocol: 'venice-video',
    createPaths: /^\/api\/v1\/video\/queue$/,
    jobPaths: {},
    bodyJobPaths: [
      { path: /^\/api\/v1\/video\/retrieve$/, action: 'download' },
      { path: /^\/api\/v1\/video\/complete$/, action: 'cancel' },
    ],
    bodyJobId: body => body.queue_id,
    jobId: body => body.queue_id,
    jobIdPattern: SIMPLE_ID,
    // Venice sends durations as strings such as "5s".
    fields: body => ({ duration: typeof body.duration === 'string' ? body.duration.replace(/s$/, '') : body.duration, resolution: body.resolution, aspectRatio: body.aspect_ratio, audio: body.audio }),
    inputs: body => [
      ...(body.image_url ? ['first_frame' as const] : []),
      ...(body.end_image_url ? ['last_frame' as const] : []),
      ...(Array.isArray(body.reference_image_urls) && body.reference_image_urls.length ? ['reference_image' as const] : []),
      ...(body.video_url ? ['video' as const] : []),
      ...(Array.isArray(body.reference_video_urls) && body.reference_video_urls.length ? ['reference_video' as const] : []),
      ...(body.audio_url || (Array.isArray(body.reference_audio_urls) && body.reference_audio_urls.length) ? ['audio' as const] : []),
    ],
    autoDuration: ['auto', 'Auto', '-1', '1 gen'],
  },
];

function api(protocol: NativeVideoProtocol): NativeVideoApi {
  return NATIVE_VIDEO_APIS.find(entry => entry.protocol === protocol)!;
}

/**
 * Classifies a native video request. Pass the body for APIs that carry the job
 * ID in it; without a body such follow-ups are still recognised but have no
 * `resourceId`, which callers treat as an unknown job.
 */
export function nativeVideoRoute(request: Pick<SerializedHttpRequest, 'path' | 'method'> & { body?: Uint8Array }): NativeVideoRoute | null {
  const path = request.path.split('?')[0] ?? '';
  for (const entry of NATIVE_VIDEO_APIS) {
    const create = request.method === 'POST' ? entry.createPaths.exec(path) : null;
    if (create) {
      const referenced = request.body && entry.referencedJobs ? entry.referencedJobs(parseJsonObject(request.body) ?? {}) : [];
      const referencedResourceIds = referenced.map(id => typeof id === 'string' && entry.jobIdPattern.test(id) ? id : '');
      return {
        protocol: entry.protocol, action: 'create',
        ...(referencedResourceIds.length ? { referencedResourceIds } : {}),
      };
    }
    const bodyJob = request.method === 'POST' ? entry.bodyJobPaths?.find(candidate => candidate.path.test(path)) : undefined;
    if (bodyJob) {
      const resourceId = request.body ? entry.bodyJobId!(parseJsonObject(request.body) ?? {}) : undefined;
      const valid = typeof resourceId === 'string' && entry.jobIdPattern.test(resourceId);
      return { protocol: entry.protocol, action: bodyJob.action, ...(valid ? { resourceId } : {}) };
    }
    const job = entry.jobPaths[request.method as 'GET' | 'DELETE']?.exec(path);
    if (job) return { protocol: entry.protocol, action: request.method === 'GET' ? 'status' : 'cancel', resourceId: job[1]! };
  }
  return null;
}

/** Job ID from a successful create response, or null when the seller did not accept a job. */
export function nativeVideoAcceptance(protocol: NativeVideoProtocol, response: SerializedHttpResponse): string | null {
  if (response.statusCode < 200 || response.statusCode >= 300) return null;
  const body = parseJsonObject(response.body);
  if (!body || body.error) return null;
  const entry = api(protocol);
  const resource = entry.jobId(body);
  return typeof resource === 'string' && resource.length <= 512 && entry.jobIdPattern.test(resource) ? resource : null;
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
  const entry = api(route.protocol);
  const fields = entry.fields(body);
  const count = 1;
  const duration = entry.autoDuration?.includes(fields.duration) ? undefined : positiveInteger(fields.duration);
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
  const entry = api(route.protocol);
  const fields = entry.fields(body);
  const inputs = [...new Set(entry.inputs(body))];
  const duration = entry.autoDuration?.includes(fields.duration) ? undefined : positiveInteger(fields.duration);
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

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

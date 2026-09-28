import type { NativeVideoProtocol, SerializedHttpRequest, SerializedHttpResponse } from './types.js';
import { extractRequestBodyFields, parseJsonObject } from './utils.js';

export type { NativeVideoProtocol };

export interface NativeVideoRoute {
  protocol: NativeVideoProtocol;
  action: 'create' | 'status' | 'cancel' | 'download';
  resourceId?: string;
  model?: string;
  resultIndex?: number;
  /** Earlier jobs a create builds on (Seedance draft tasks). Invalid IDs are kept as '' so ownership checks fail. */
  referencedResourceIds?: string[];
}

type JsonObject = Record<string, unknown>;

interface VideoRequestFields {
  count?: unknown;
  duration?: unknown;
  resolution?: unknown;
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
  /** Sentinel duration values meaning "let the model decide". */
  autoDuration?: unknown[];
  /** Maps equivalent job IDs to one ownership key. */
  resourceKey?: (resourceId: string) => string;
}

const ID = '[A-Za-z0-9_-]+';
const SIMPLE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const VEO_OPERATION = new RegExp(`^(?:models/[A-Za-z0-9._-]+/)?operations/${ID}$`);
const VEO_DOWNLOAD = new RegExp(`^/v1beta/((?:models/[A-Za-z0-9._-]+/)?operations/${ID})/videos/([0-9]{1,3}):download$`);

export function veoDownloadPath(operation: string, resultIndex: number): string {
  if (!VEO_OPERATION.test(operation) || !Number.isInteger(resultIndex) || resultIndex < 0 || resultIndex > 999) {
    throw new Error('Invalid video download');
  }
  return `/v1beta/${operation}/videos/${resultIndex}:download`;
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {};
}

const NATIVE_VIDEO_APIS: NativeVideoApi[] = [
  {
    protocol: 'veo-video',
    createPaths: /^\/v1beta\/models\/([A-Za-z0-9._-]+):predictLongRunning$/,
    jobPaths: { GET: new RegExp(`^/v1beta/((?:models/[A-Za-z0-9._-]+/)?operations/${ID})$`) },
    jobId: body => body.name,
    jobIdPattern: VEO_OPERATION,
    fields: body => {
      const parameters = object(body.parameters);
      return { count: veoVideoCount(parameters), duration: parameters.durationSeconds, resolution: parameters.resolution };
    },
    resourceKey: resourceId => resourceId.replace(/^models\/[^/]+\//, ''),
  },
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
    fields: body => ({ duration: body.frames === undefined ? body.duration : undefined, resolution: body.resolution }),
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
    fields: body => ({ duration: typeof body.duration === 'string' ? body.duration.replace(/s$/, '') : body.duration, resolution: body.resolution }),
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
  const download = request.method === 'GET' ? VEO_DOWNLOAD.exec(path) : null;
  if (download) return { protocol: 'veo-video', action: 'download', resourceId: download[1]!, resultIndex: Number(download[2]) };
  for (const entry of NATIVE_VIDEO_APIS) {
    const create = request.method === 'POST' ? entry.createPaths.exec(path) : null;
    if (create) {
      const referenced = request.body && entry.referencedJobs ? entry.referencedJobs(parseJsonObject(request.body) ?? {}) : [];
      const referencedResourceIds = referenced.map(id => typeof id === 'string' && entry.jobIdPattern.test(id) ? id : '');
      return {
        protocol: entry.protocol, action: 'create',
        ...(create[1] ? { model: create[1] } : {}),
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

export function nativeVideoResourceKey(protocol: NativeVideoProtocol, resourceId: string): string {
  return api(protocol).resourceKey?.(resourceId) ?? resourceId;
}

export function requestService(request: SerializedHttpRequest): string | undefined {
  const route = nativeVideoRoute(request);
  if (route?.model) return route.model;
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
  const count = fields.count === undefined ? 1 : fields.count;
  const duration = entry.autoDuration?.includes(fields.duration) ? undefined : positiveInteger(fields.duration);
  if (typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) throw new Error('Video sample count must be a positive integer');
  if (duration === null) throw new Error('Video duration must be a positive integer');
  if (duration !== undefined && !Number.isSafeInteger(duration * count)) throw new Error('Video quantity exceeds the safe integer limit');
  return {
    protocol: route.protocol, action: route.action, count,
    ...(duration === undefined ? {} : { duration }),
    ...(typeof fields.resolution === 'string' ? { resolution: fields.resolution } : {}),
  };
}

/** Positive integer from a number or decimal string; undefined when absent, null when invalid. */
function positiveInteger(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  const parsed = typeof value === 'string' && /^[0-9]+$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/** Gemini API uses `numberOfVideos`; Vertex AI uses `sampleCount`. Both must agree when present. */
function veoVideoCount(parameters: JsonObject): number {
  const numberOfVideos = positiveInteger(parameters.numberOfVideos);
  const sampleCount = positiveInteger(parameters.sampleCount);
  if (numberOfVideos === null || sampleCount === null) return Number.NaN;
  if (numberOfVideos !== undefined && sampleCount !== undefined && numberOfVideos !== sampleCount) {
    throw new Error('Veo numberOfVideos and sampleCount disagree');
  }
  return numberOfVideos ?? sampleCount ?? 1;
}

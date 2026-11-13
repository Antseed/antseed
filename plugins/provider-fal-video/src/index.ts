import type { AntseedProviderPlugin, Provider, ProviderRequestRefusal, SerializedHttpRequest, ServiceCapabilities, ServiceHealthStatus, UpstreamAccountStatus, VideoInputKind } from '@antseed/node';
import { VIDEO_DOWNLOAD_STREAM_HEADER, VIDEO_DOWNLOAD_STREAM_VERSION, validateServiceCapabilityFields } from '@antseed/node';
import { audioSourceLengthProblem, nativeVideoRoute, parseJsonObject, referenceVideoPriceProblem, requestService, videoSourceLengthProblem } from '@antseed/api-adapter';
import {
  FAL_PLATFORM_URL,
  FAL_SCHEMA_URL,
  falEndpointInput,
  falErrorReason,
  falUpstreamAccountStatus,
  isFalEndpointId,
  parseCsv,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  createVideoResponseStreamer,
  readFalAccount,
  readFalModelStatuses,
  readVideoJson as readJson,
  videoDownloadError as error,
  videoDownloadSignal,
  videoJsonResponse as json,
  videoSubmitTimeoutMs,
} from '@antseed/provider-core';

export const FAL_DEFAULT_BASE_URL = 'https://queue.fal.run';
export { FAL_PLATFORM_URL, FAL_SCHEMA_URL, falErrorReason };
export const FAL_STORAGE_URL = 'https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3';

const PROTOCOL = 'fal-video';
const MAX_ACTIVE_DOWNLOADS = 2;

/** What an endpoint's fal input schema says about its fields. */
export interface FalInputSchema {
  /** Field names, sorted, or null when they cannot be announced as-is. */
  parameters: string[] | null;
  /** All field names in the schema. */
  fields: string[];
  /** Fields the endpoint requires. */
  required: string[];
  /** Source length range fal states in `video_url`'s `x-fal` metadata, in seconds. */
  sourceSeconds?: { min?: number; max?: number };
  /** The `resolution` field's allowed values, when the schema lists them. */
  resolutions?: string[];
}

/** Reads an endpoint's input fields, required fields, source length range and resolutions from its fal OpenAPI schema. */
export function falInputSchema(schema: Record<string, unknown> | null, endpointId: string): FalInputSchema | null {
  const input = falEndpointInput(schema, endpointId);
  if (!input) return null;
  const { properties } = input;
  const fields = Object.keys(properties).sort();
  const parameters = validateServiceCapabilityFields({ supportedParameters: fields }).length === 0 ? fields : null;
  const required = input.required.filter(field => fields.includes(field));
  const limits = properties.video_url?.['x-fal'];
  const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  const min = number(limits?.min_duration);
  const max = number(limits?.max_duration);
  const resolutionEnum = properties.resolution?.enum;
  const resolutions = Array.isArray(resolutionEnum) && resolutionEnum.length > 0 && resolutionEnum.length <= 16
    && resolutionEnum.every((value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 32)
    ? resolutionEnum as string[]
    : undefined;
  return {
    parameters, fields, required,
    ...(min !== undefined || max !== undefined ? { sourceSeconds: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } } : {}),
    ...(resolutions ? { resolutions } : {}),
  };
}

/** fal input field names from an endpoint's OpenAPI schema, or null when they cannot be announced as-is. */
export function falInputParameters(schema: Record<string, unknown> | null, endpointId: string): string[] | null {
  return falInputSchema(schema, endpointId)?.parameters ?? null;
}

/** Fields of a video-to-video endpoint that carry each media input. */
const EDIT_INPUT_FIELDS: Record<VideoInputKind, readonly string[]> = {
  video: ['video_url'],
  reference_video: ['reference_video_urls'],
  // In a video-to-video endpoint an image is the new character or style, not the opening frame.
  reference_image: ['reference_image_urls', 'reference_image_url', 'ref_image_urls', 'image_urls', 'image_url', 'elements'],
  first_frame: ['start_image_url', 'first_frame_url'],
  last_frame: ['end_image_url', 'tail_image_url', 'last_frame_url'],
  audio: ['audio_url'],
};

/**
 * How the seller handles a video-to-video endpoint (one with a `video_url`
 * field). The buyer pays for `duration`, which must be the source's measured
 * length: fal bills every edit for at least its source, and an endpoint that
 * takes a `duration` cuts the output to the source, so a longer one would be
 * delivered short and never charged.
 */
export interface FalEditRule {
  /**
   * The endpoint has no `duration` field, so its output is as long as the
   * source: the buyer's `duration` (what it pays for) is removed before the
   * request goes to fal.
   */
  outputFollowsSource: boolean;
}

/** The seller's handling of a video-to-video endpoint, or null for other endpoints. */
export function falEditRule(input: FalInputSchema | null): FalEditRule | null {
  if (!input?.fields.includes('video_url')) return null;
  return { outputFollowsSource: !input.fields.includes('duration') };
}

/**
 * Video options of a video-to-video endpoint: the media inputs its fields
 * take and require, and the durations it accepts (the source lengths fal
 * takes). Options the seller configured are kept.
 */
export function withEditInputs(capabilities: ServiceCapabilities, input: FalInputSchema | null, rule: FalEditRule | null): ServiceCapabilities {
  return input && rule ? withSchemaInputs(capabilities, input, EDIT_INPUT_FIELDS) : capabilities;
}

/**
 * Video options from an endpoint's schema: the media inputs its fields take
 * (`fieldsByKind`) and require, the source lengths fal takes as durations,
 * and the resolutions. Options the seller configured are kept.
 */
function withSchemaInputs(capabilities: ServiceCapabilities, input: FalInputSchema, fieldsByKind: Partial<Record<VideoInputKind, readonly string[]>>): ServiceCapabilities {
  const fieldsOf = (kind: VideoInputKind) => fieldsByKind[kind] ?? [];
  const kinds = (Object.keys(fieldsByKind) as VideoInputKind[]).filter(kind => fieldsOf(kind).some(field => input.fields.includes(field)));
  const required = kinds.filter(kind => fieldsOf(kind).some(field => input.required.includes(field)));
  const configured = capabilities.video ?? {};
  const inputs = configured.inputs ? [...configured.inputs, ...kinds.filter(kind => !configured.inputs!.includes(kind))] : kinds;
  const requiredInputs = configured.requiredInputs ?? (required.length > 0 ? required : undefined);
  // `duration` is the source length, so the durations a buyer may pay for are the source lengths fal takes.
  const min = input.sourceSeconds?.min;
  const max = input.sourceSeconds?.max;
  const durations = min !== undefined && max !== undefined
    ? Array.from({ length: Math.max(0, Math.floor(max) - Math.ceil(min) + 1) }, (_, i) => Math.ceil(min) + i)
    : [];
  return {
    ...capabilities,
    video: {
      ...configured,
      inputs,
      ...(requiredInputs ? { requiredInputs } : {}),
      ...(!configured.durationsSeconds && durations.length > 0 && durations.length <= 64 ? { durationsSeconds: durations } : {}),
      ...(!configured.resolutions && input.resolutions ? { resolutions: [...input.resolutions] } : {}),
    },
  };
}

const FRAME_INPUT_FIELDS = {
  first_frame: ['image_url', 'start_image_url', 'first_frame_url', 'first_image_url'],
  last_frame: ['end_image_url', 'tail_image_url', 'last_frame_url', 'last_image_url'],
  reference_video: ['video_urls', 'reference_video_urls'],
} as const;

/**
 * The common reference-media names (Venice's, and other sellers') and the fal
 * field each one is. fal's Seedance reference-to-video takes `image_urls`,
 * `audio_urls` and `video_urls`; the seller announces the common names too and
 * renames them before the request goes to fal, so one request works on either.
 */
export const FAL_REFERENCE_ALIASES = {
  reference_image_urls: 'image_urls',
  reference_audio_urls: 'audio_urls',
  reference_video_urls: 'video_urls',
} as const;

type FalReferenceAlias = keyof typeof FAL_REFERENCE_ALIASES;

/** The common names an endpoint takes: those whose fal field it has and whose own name it lacks. */
export function falReferenceAliases(fields: readonly string[]): FalReferenceAlias[] {
  return (Object.keys(FAL_REFERENCE_ALIASES) as FalReferenceAlias[])
    .filter(alias => fields.includes(FAL_REFERENCE_ALIASES[alias]) && !fields.includes(alias));
}

/**
 * Renames the common reference names in a create to the endpoint's fal fields,
 * in place. `fields` is the endpoint's schema, or undefined when it was not
 * read (then every common name is renamed). Returns why the create can't be
 * renamed (both names sent), or null.
 */
export function renameFalReferenceAliases(input: Record<string, unknown>, fields: readonly string[] | undefined): string | null {
  for (const alias of Object.keys(FAL_REFERENCE_ALIASES) as FalReferenceAlias[]) {
    const field = FAL_REFERENCE_ALIASES[alias];
    if (input[alias] === undefined || fields?.includes(alias)) continue;
    if (input[field] !== undefined) return `Send ${alias} or ${field}, not both`;
    input[field] = input[alias];
    delete input[alias];
  }
  return null;
}

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

/** Request fields that set a video's length. */
const LENGTH_FIELDS = ['duration', 'num_frames'];

/**
 * Whether an endpoint makes a video as long as its input audio, as talking
 * avatars such as Kling AI Avatar do: it requires `audio_url`, takes no source
 * video, and has no field that sets the length. fal bills it by that length,
 * so the buyer pays for a `duration` that must be the audio's measured length;
 * the seller removes `duration` before the request goes to fal.
 */
export function falFollowsAudio(input: FalInputSchema | null): boolean {
  return !!input && input.required.includes('audio_url') && !input.fields.includes('video_url')
    && !LENGTH_FIELDS.some(field => input.fields.includes(field));
}

/** Fields of an endpoint that follows its audio that carry each media input. */
const AUDIO_INPUT_FIELDS: Partial<Record<VideoInputKind, readonly string[]>> = {
  ...FRAME_INPUT_FIELDS,
  reference_image: ['reference_image_urls', 'image_urls'],
  audio: ['audio_url'],
};

/** Video options of an endpoint that follows its audio: the media inputs its fields take and require. */
export function withAudioInputs(capabilities: ServiceCapabilities, input: FalInputSchema | null): ServiceCapabilities {
  return input && falFollowsAudio(input) ? withSchemaInputs(capabilities, input, AUDIO_INPUT_FIELDS) : capabilities;
}

/** Time allowed to send a create to fal and get its answer: 60 s plus 1 s per 256 KB of body, at most 10 min. */
export const falSubmitTimeoutMs = videoSubmitTimeoutMs;

/**
 * Upload an inline `data:video/...;base64` or `data:audio/...;base64` source
 * to fal's file storage (as fal's own clients do) and return its URL, kept
 * for a day. Some fal endpoints (Kling motion control, OmniHuman) accept only
 * a URL for `video_url` or `audio_url`. Anything else is returned unchanged.
 */
async function uploadInlineMedia(source: unknown, kind: 'video' | 'audio', authorization: string, signal: AbortSignal): Promise<unknown> {
  if (typeof source !== 'string') return source;
  const match = /^data:([a-z]+\/[a-z0-9.+-]+)(?:;[a-z0-9.+-]+=[^;,]*)*;base64,/i.exec(source.slice(0, 256));
  const mediaType = match?.[1]?.toLowerCase();
  if (!match || !mediaType?.startsWith(`${kind}/`)) return source;
  const bytes = Buffer.from(source.slice(match[0].length), 'base64');
  // Audio was measured as MP3 or WAV by its bytes, whatever its label.
  let contentType = mediaType;
  let fileName = mediaType === 'video/quicktime' ? 'source.mov' : 'source.mp4';
  if (kind === 'audio') {
    const isWav = bytes.subarray(0, 4).toString('latin1') === 'RIFF';
    contentType = isWav ? 'audio/wav' : 'audio/mpeg';
    fileName = isWav ? 'source.wav' : 'source.mp3';
  }
  const initiate = await fetch(FAL_STORAGE_URL, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json', 'x-fal-object-lifecycle': JSON.stringify({ expiration_duration_seconds: 86_400 }) },
    body: JSON.stringify({ content_type: contentType, file_name: fileName }),
    redirect: 'error',
    signal,
  });
  const target = await readJson(initiate);
  const uploadUrl = target?.upload_url;
  const fileUrl = target?.file_url;
  if (!initiate.ok || typeof uploadUrl !== 'string' || typeof fileUrl !== 'string' || !uploadUrl.startsWith('https://') || !fileUrl.startsWith('https://')) {
    throw new Error(`fal storage did not accept the upload (HTTP ${initiate.status})`);
  }
  const upload = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: bytes,
    redirect: 'error',
    signal,
  });
  await upload.body?.cancel();
  if (!upload.ok) throw new Error(`fal storage upload failed (HTTP ${upload.status})`);
  return fileUrl;
}

/** fal's queue status and result URLs use only `owner/alias`, not the endpoint's sub-path. */
export function falAppId(endpointId: string): string {
  return endpointId.split('/').slice(0, 2).join('/');
}

/** Startup notice when the seller key cannot read the fal balance. */
export const FAL_BALANCE_CHECK_OFF =
  'fal balance check is off: FAL_VIDEO_API_KEY lacks the billing:usage:read permission. '
  + 'Running out of fal credits will not stop this seller advertising. '
  + 'To turn the check on, give the key that permission (fal presets BILLING, READONLY or FULL) and restart.';

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
      key: 'FAL_VIDEO_MIN_BALANCE_USD',
      label: 'Minimum Balance (USD)',
      type: 'number',
      default: 0,
      description: 'Stop advertising video models while the fal balance is at or below this amount. Needs FAL_VIDEO_API_KEY to have the billing:usage:read permission',
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
    const invalid = services.find(service => !isFalEndpointId(service));
    if (invalid) throw new Error(`Invalid fal endpoint ID: ${invalid}`);
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const missingPricing = services.find(service => !serviceUnitBillingModels?.[service]?.[PROTOCOL]);
    if (missingPricing) throw new Error(`Missing ${PROTOCOL} unit pricing for ${missingPricing}`);
    const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const authorization = `Key ${apiKey}`;
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

    // Off once fal says the seller key can't read billing; the key's permissions don't change while running.
    let balanceCheck = true;

    // Video-to-video endpoints: `duration` must be the source length, and is removed when fal takes none.
    const editRules = new Map<string, FalEditRule>();
    // Endpoints whose video is as long as their audio: `duration` must be the audio length, and is removed.
    const audioServices = new Set<string>();
    // Each endpoint whose fal schema was read, with its input fields.
    const schemaFields = new Map<string, readonly string[]>();

    // Announces each endpoint's own input field names, so buyers can call fal's API unchanged.
    const init = async () => {
      await Promise.all(services.map(async service => {
        try {
          const response = await fetch(`${FAL_SCHEMA_URL}?endpoint_id=${encodeURIComponent(service)}`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
          const input = response.ok ? falInputSchema(await readJson(response), service) : null;
          const capabilities = serviceCapabilities[service]!;
          if (input?.parameters && !capabilities.supportedParameters) {
            capabilities.supportedParameters = [...input.parameters, ...falReferenceAliases(input.fields)].sort();
          }
          if (input) schemaFields.set(service, input.fields);
          const rule = falEditRule(input);
          if (rule) {
            editRules.set(service, rule);
            serviceCapabilities[service] = withEditInputs(capabilities, input, rule);
          } else if (falFollowsAudio(input)) {
            audioServices.add(service);
            serviceCapabilities[service] = withAudioInputs(capabilities, input);
          }
        } catch {
          // Unknown input fields: buyers fall back to the common names.
        }
      }));
      for (const service of services) {
        if (!editRules.has(service) && !audioServices.has(service)) serviceCapabilities[service] = withFrameInputs(serviceCapabilities[service]!);
      }
      const account = await readFalAccount(FAL_PLATFORM_URL, authorization);
      if (account.status === 'no_permission') {
        balanceCheck = false;
        warnOnce(FAL_BALANCE_CHECK_OFF);
      } else if (account.status === 'ok') {
        console.log(`[fal-video] fal balance check is on: $${account.balanceUsd.toFixed(2)}; models stop being advertised at or below $${minBalanceUsd}`);
      }
    };

    const route = (request: SerializedHttpRequest) => {
      const videoRoute = nativeVideoRoute(request);
      const service = requestService(request);
      return { videoRoute, service: service && services.includes(service) ? service : undefined };
    };

    /**
     * Whether a create's video is as long as its audio. Without the endpoint's
     * schema, an `audio_url` without a source video marks one, unless the
     * service's configured fields include one that sets the length.
     */
    const followsAudio = (service: string, input: Record<string, unknown>) => audioServices.has(service)
      || (!schemaFields.has(service) && input.audio_url !== undefined && input.video_url === undefined
        && !LENGTH_FIELDS.some(field => serviceCapabilities[service]!.supportedParameters?.includes(field)));

    /**
     * Why a create can't be paid for its `duration`, or null. The buyer pays
     * for `duration`, so for an edit it must be the source's measured length
     * (see FalEditRule), and for an endpoint that follows its audio the
     * audio's (see falFollowsAudio). The schema decides first: an extra
     * `video_url` on an endpoint that follows its audio does not change what
     * it is paid by. Without the endpoint's schema, a source video marks an edit.
     */
    const lengthProblem = (service: string, input: Record<string, unknown>): string | null => {
      if (audioServices.has(service)) return audioSourceLengthProblem(input.audio_url, input.duration);
      if (editRules.has(service) || input.video_url !== undefined) return videoSourceLengthProblem(input.video_url, input.duration);
      if (followsAudio(service, input)) return audioSourceLengthProblem(input.audio_url, input.duration);
      return null;
    };

    /** Why a create's reference videos are not covered by the service's price, or null. */
    const referencePriceProblem = (request: SerializedHttpRequest, service: string, body: Record<string, unknown>) =>
      referenceVideoPriceProblem(request, service, serviceUnitBillingModels?.[service]?.[PROTOCOL]?.components, undefined, body);

    // Run before any payment, so a refused create costs the buyer nothing.
    const checkRequest = (request: SerializedHttpRequest): ProviderRequestRefusal | null => {
      const { videoRoute, service } = route(request);
      if (videoRoute?.action !== 'create' || !service) return null;
      const body = parseJsonObject(request.body);
      if (!body) return null;
      const unpriced = referencePriceProblem(request, service, body);
      if (unpriced) return { statusCode: 400, code: 'unsupported_video_input', message: unpriced };
      const renamed = renameFalReferenceAliases({ ...body }, schemaFields.get(service));
      if (renamed) return { statusCode: 400, code: 'invalid_video_request', message: renamed };
      const refused = lengthProblem(service, body);
      return refused ? { statusCode: 422, code: 'invalid_video_duration', message: refused } : null;
    };

    let active = 0;

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
        // The seller checks these before payment too (checkRequest).
        const unpriced = referencePriceProblem(request, service, body);
        if (unpriced) return error(request, 400, 'unsupported_video_input', unpriced);
        const refused = lengthProblem(service, input);
        if (refused) return error(request, 422, 'invalid_video_duration', refused);
        const renamed = renameFalReferenceAliases(input, schemaFields.get(service));
        if (renamed) return error(request, 400, 'invalid_video_request', renamed);
        const followsAudioLength = followsAudio(service, input);
        // An endpoint that takes no `duration` gets none: its output follows the source or the audio.
        if (editRules.get(service)?.outputFollowsSource || audioServices.has(service)) delete input.duration;
        // The upload of a large inline source counts toward the timeout: allow 60 s plus 1 s per 256 KB.
        const signal = AbortSignal.timeout(falSubmitTimeoutMs(request.body.length));
        // An inline source goes to fal's storage first: some endpoints take video_url or audio_url only as a URL.
        if (input.video_url !== undefined) input.video_url = await uploadInlineMedia(input.video_url, 'video', authorization, signal);
        if (followsAudioLength) input.audio_url = await uploadInlineMedia(input.audio_url, 'audio', authorization, signal);
        const upstream = await fetch(`${baseUrl}/${service}`, {
          method: 'POST',
          headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify(input),
          redirect: 'error',
          signal,
        });
        const accepted = await readJson(upstream);
        if (upstream.status >= 400 && upstream.status < 500) {
          return json(request, upstream.status, { error: { code: 'fal_request_rejected', message: falErrorReason(accepted) ?? `fal answered HTTP ${upstream.status}` } });
        }
        if (!upstream.ok || typeof accepted?.request_id !== 'string') return error(request, 502, 'fal_request_failed', 'fal did not accept the request');
        // fal's status/response URLs need the seller's key, so only the ID is returned.
        return json(request, 200, { model: service, request_id: accepted.request_id, status: 'IN_QUEUE' });
      } catch (cause) {
        if (cause instanceof Error && cause.name === 'TimeoutError') {
          return error(request, 504, 'upstream_upload_timeout', `Sending the request to fal timed out (${(request.body.length / 1_000_000).toFixed(1)} MB). Send the source as a public https URL or a smaller file`);
        }
        return error(request, 502, 'fal_request_failed', 'Could not submit the request to fal');
      } finally {
        active -= 1;
      }
    };

    const streamUpstream = createVideoResponseStreamer(MAX_ACTIVE_DOWNLOADS);

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
      checkRequest,
      handleRequest,
      async checkServiceHealth(checked) {
        const statuses = await readFalModelStatuses(FAL_PLATFORM_URL, authorization, checked);
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
      async checkUpstreamAccount(): Promise<UpstreamAccountStatus> {
        if (!balanceCheck) return { status: 'unknown', reason: 'fal balance check is off (key lacks billing:usage:read)' };
        const account = await readFalAccount(FAL_PLATFORM_URL, authorization);
        if (account.status === 'no_permission') {
          balanceCheck = false;
          warnOnce(FAL_BALANCE_CHECK_OFF);
          return { status: 'unknown', reason: 'fal balance check is off (key lacks billing:usage:read)' };
        }
        return falUpstreamAccountStatus(account, minBalanceUsd);
      },
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
          if (status.error) {
            console.warn(`[fal-video] ${service} job ${videoRoute.resourceId} failed: ${String(status.error).slice(0, 200)}`);
            return json(request, 200, { status: 'FAILED', error: String(status.error).slice(0, 500) });
          }

          const resultResponse = await get(requestUrl);
          const result = await readJson(resultResponse);
          if (!resultResponse.ok) {
            // A temporary fal error must not end the job: FAILED releases its
            // payment channel, and the next retrieve may still deliver the video.
            if (resultResponse.status === 408 || resultResponse.status === 429 || resultResponse.status >= 500) {
              return error(request, 502, 'video_result_unavailable', 'fal result is temporarily unavailable');
            }
            // fal reports a job it refused (bad input, content checks) as COMPLETED and answers its result with
            // a 4xx; a job whose result is already gone answers 404 "Request not found".
            const reason = falErrorReason(result);
            console.warn(`[fal-video] ${service} job ${videoRoute.resourceId} failed: HTTP ${resultResponse.status} ${reason ?? '(no reason)'}`);
            return json(request, 200, reason === undefined
              ? { status: 'FAILED', error: `fal answered HTTP ${resultResponse.status} with no reason` }
              : { status: 'FAILED', error: reason });
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

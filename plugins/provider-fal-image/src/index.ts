import type { AntseedProviderPlugin, Provider, SerializedHttpRequest, SerializedHttpResponse, ServiceCapabilities, ServiceHealthStatus, UpstreamAccountStatus } from '@antseed/node';
import { requestBodyFields, validateServiceCapabilityFields } from '@antseed/node';
import { parseJsonObject } from '@antseed/api-adapter';
import {
  FAL_PLATFORM_URL,
  FAL_SCHEMA_URL,
  falErrorReason,
  getHeader,
  parseCsv,
  parseServiceCapabilitiesJson,
  parseServiceUnitBillingModelsJson,
  readFalAccount,
  readFalModelStatuses,
} from '@antseed/provider-core';

export const FAL_IMAGE_DEFAULT_BASE_URL = 'https://fal.run';

const PROTOCOL = 'openai-images';
const GENERATIONS_PATH = '/v1/images/generations';
const EDITS_PATH = '/v1/images/edits';
/** A generation (fal runs it while the request waits) and the image downloads. */
const REQUEST_TIMEOUT_MS = 5 * 60_000;
const SCHEMA_TIMEOUT_MS = 10_000;
const MAX_RESULT_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 32 * 1024 * 1024;
/** fal endpoint IDs: `owner/alias[/path...]`, at most 64 characters (the discovery service-name limit). */
const ENDPOINT_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;
const SIZE = /^(\d{2,5})x(\d{2,5})$/;

/**
 * OpenAI request fields the seller maps to fal's own. `size`, `quality` and
 * `resolution` are what a request is priced by (see the image billing
 * attributes), and `n` how many images it pays for, so fal's own fields for
 * them are refused: a request could otherwise buy a larger or extra image
 * than the one it is billed for.
 */
const OPENAI_FIELDS = new Set(['model', 'service', 'prompt', 'n', 'size', 'quality', 'resolution', 'response_format', 'moderation', 'user']);
const SET_BY_SELLER = new Set(['image_size', 'num_images', 'max_images', 'sync_mode', 'image_url', 'image_urls', 'mask_url']);
/** fal fields passed on unchanged when the endpoint takes them. None changes fal's price. */
const PASSTHROUGH_FIELDS = new Set([
  'aspect_ratio', 'background', 'enable_safety_checker', 'negative_prompt', 'output_compression',
  'output_format', 'safety_tolerance', 'seed',
]);
/** OpenAI clients send several images as repeated `image[]` parts, one image as `image`. */
const IMAGE_FIELDS = new Set(['image', 'image[]']);

/** Input fields of a fal endpoint, from its OpenAPI schema. */
export interface FalImageSchema {
  fields: Set<string>;
  /** The values `image_size` takes as a name (`square_hd`, `auto`, ...). */
  sizePresets: string[];
}

/** Reads an endpoint's input fields and `image_size` presets from its fal OpenAPI schema. */
export function falImageSchema(schema: Record<string, unknown> | null, endpointId: string): FalImageSchema | null {
  const paths = schema?.paths as Record<string, any> | undefined;
  const ref = paths?.[`/${endpointId}`]?.post?.requestBody?.content?.['application/json']?.schema?.$ref;
  if (typeof ref !== 'string') return null;
  const properties = (schema?.components as Record<string, any> | undefined)?.schemas?.[ref.split('/').pop()!]?.properties;
  if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return null;
  const imageSize = properties.image_size;
  const presets = [imageSize?.enum, ...(Array.isArray(imageSize?.anyOf) ? imageSize.anyOf.map((option: any) => option?.enum) : [])]
    .flatMap(values => Array.isArray(values) ? values.filter((value: unknown): value is string => typeof value === 'string') : []);
  return { fields: new Set(Object.keys(properties)), sizePresets: presets };
}

class RequestError extends Error {
  constructor(readonly statusCode: number, message: string, readonly param?: string) {
    super(message);
  }
}

function openAiError(requestId: string, statusCode: number, message: string, param?: string): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: Buffer.from(JSON.stringify({
      error: { message, type: statusCode >= 500 ? 'upstream_error' : 'invalid_request_error', ...(param ? { param } : {}) },
    })),
  };
}

/**
 * fal's input for an OpenAI image request: `n` becomes `num_images`, `size`
 * becomes `image_size` (`WxH` as width and height, or one of fal's preset
 * names), and the fal fields in PASSTHROUGH_FIELDS go on unchanged. Without
 * the endpoint's schema every mapped field is sent; with it, a field the
 * endpoint does not take is refused rather than dropped, since the request
 * may be priced by it.
 */
export function falImageInput(fields: Record<string, unknown>, schema: FalImageSchema | null): Record<string, unknown> {
  const takes = (field: string) => !schema || schema.fields.has(field);
  const input: Record<string, unknown> = {};
  for (const [field, value] of Object.entries(fields)) {
    if (SET_BY_SELLER.has(field)) throw new RequestError(400, `Send "${field}" in OpenAI form (size, n, image), not as fal's own field.`, field);
    if (!OPENAI_FIELDS.has(field) && !PASSTHROUGH_FIELDS.has(field)) throw new RequestError(400, `Unsupported field "${field}".`, field);
    if (PASSTHROUGH_FIELDS.has(field)) {
      if (!takes(field)) throw new RequestError(400, `This model does not take "${field}".`, field);
      input[field] = value;
    }
  }

  const prompt = typeof fields.prompt === 'string' ? fields.prompt.trim() : '';
  if (!prompt) throw new RequestError(400, 'prompt is required.', 'prompt');
  input.prompt = prompt;

  const count = fields.n === undefined ? 1 : Number(fields.n);
  if (!Number.isSafeInteger(count) || count < 1 || count > 8) throw new RequestError(400, 'n must be an integer from 1 to 8.', 'n');
  if (count > 1) {
    if (!takes('num_images')) throw new RequestError(400, 'This model makes one image per request.', 'n');
    input.num_images = count;
  }

  const size = typeof fields.size === 'string' ? fields.size.trim() : '';
  const dimensions = SIZE.exec(size);
  if (dimensions) {
    if (!takes('image_size')) throw new RequestError(400, 'This model does not take a size; use aspect_ratio or resolution.', 'size');
    input.image_size = { width: Number(dimensions[1]), height: Number(dimensions[2]) };
  } else if (size && size !== 'auto') {
    if (!schema?.sizePresets.includes(size)) throw new RequestError(400, `Unsupported size "${size}".`, 'size');
    input.image_size = size;
  } else if (size === 'auto' && schema?.sizePresets.includes('auto')) {
    input.image_size = 'auto';
  }

  for (const field of ['quality', 'resolution'] as const) {
    const value = typeof fields[field] === 'string' ? (fields[field] as string).trim() : '';
    if (!value || (field === 'quality' && value === 'auto' && !takes('quality'))) continue;
    if (!takes(field)) throw new RequestError(400, `This model does not take "${field}".`, field);
    input[field] = value;
  }

  const moderation = typeof fields.moderation === 'string' ? fields.moderation.trim() : '';
  if (moderation && moderation !== 'auto' && moderation !== 'low') throw new RequestError(400, 'moderation must be "auto" or "low".', 'moderation');
  if (moderation === 'low' && takes('enable_safety_checker') && input.enable_safety_checker === undefined) input.enable_safety_checker = false;

  const responseFormat = fields.response_format ?? 'b64_json';
  if (responseFormat !== 'b64_json' && responseFormat !== 'url') throw new RequestError(400, 'response_format must be "b64_json" or "url".', 'response_format');
  // fal then answers with the images inline (data URIs) and keeps no copy.
  if (responseFormat === 'b64_json' && takes('sync_mode')) input.sync_mode = true;
  return input;
}

/** The fal images of a result: `images`, or a single `image`. */
function resultImages(result: Record<string, unknown> | null): Array<{ url: string; content_type?: string }> {
  const images = Array.isArray(result?.images) ? result.images : result?.image ? [result.image] : [];
  return images.filter((image): image is { url: string; content_type?: string } => typeof (image as { url?: unknown })?.url === 'string');
}

async function readBounded(response: Response, maxBytes: number): Promise<Buffer | null> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const body = Buffer.from(await response.arrayBuffer());
  return body.length > maxBytes ? null : body;
}

/**
 * Whether a URL is on fal's media CDN (`fal.media` and its subdomains, such as
 * `v3.fal.media`), the only place the seller downloads a result image from: a
 * result naming any other host is not fetched, so it can't point the seller at
 * its own network or another service.
 */
export function isFalMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return url.protocol === 'https:' && !url.username && !url.password && (url.port === '' || url.port === '443')
      && (host === 'fal.media' || host.endsWith('.fal.media'));
  } catch {
    return false;
  }
}

/** An OpenAI image entry for a fal image: `b64_json` (fetching a URL fal returned), or the URL itself. */
async function openAiImage(image: { url: string }, responseFormat: 'b64_json' | 'url', signal: AbortSignal): Promise<{ b64_json: string } | { url: string }> {
  const inline = /^data:[^,]*;base64,/i.exec(image.url.slice(0, 256));
  if (responseFormat === 'url') {
    if (inline) throw new Error('fal returned an inline image for a URL request');
    return { url: image.url };
  }
  if (inline) return { b64_json: image.url.slice(inline[0].length) };
  if (!isFalMediaUrl(image.url)) throw new Error('fal returned an image outside its media CDN');
  // fal media URLs are public; never send the seller key to them.
  const file = await fetch(image.url, { redirect: 'error', signal });
  const bytes = file.ok ? await readBounded(file, MAX_IMAGE_BYTES) : null;
  if (!bytes) throw new Error(`Could not download the image from fal (HTTP ${file.status})`);
  return { b64_json: bytes.toString('base64') };
}

/** An edit's images and text fields from its multipart form. */
async function readEditForm(request: SerializedHttpRequest): Promise<{ fields: Record<string, string>; images: Blob[]; mask?: Blob }> {
  const contentType = getHeader(request.headers, 'content-type');
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) throw new RequestError(415, 'Image edits require multipart/form-data.');
  let form: FormData;
  try {
    form = await new Request('http://localhost', { method: 'POST', headers: { 'content-type': contentType }, body: request.body }).formData();
  } catch {
    throw new RequestError(400, 'Invalid multipart image edit request.');
  }
  // The seller priced this request from its own reading of the text fields, which
  // skips oversized ones and keeps the first of a name. Anything read differently
  // (a padded quality, a repeated field) could buy a dearer edit than the one billed.
  const billed = requestBodyFields(request) ?? {};
  const fields: Record<string, string> = {};
  const images: Blob[] = [];
  let mask: Blob | undefined;
  for (const [field, value] of form.entries()) {
    if (IMAGE_FIELDS.has(field) || field === 'mask') {
      if (typeof value === 'string') throw new RequestError(400, `"${field}" must be an image file.`, field);
      if (field === 'mask') mask = value;
      else images.push(value);
    } else if (typeof value !== 'string' || billed[field] !== value) {
      throw new RequestError(400, `The "${field}" field is too long, repeated or a file.`, field);
    } else {
      fields[field] = value;
    }
  }
  if (images.length === 0) throw new RequestError(400, 'Image edits require one or more image files.', 'image');
  return { fields, images, ...(mask ? { mask } : {}) };
}

async function dataUrl(file: Blob): Promise<string> {
  const type = file.type && /^image\/[a-z0-9.+-]+$/i.test(file.type) ? file.type : 'image/png';
  return `data:${type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}`;
}

/** Startup notice when the seller key cannot read the fal balance. */
export const FAL_IMAGE_BALANCE_CHECK_OFF =
  'fal balance check is off: FAL_IMAGE_API_KEY lacks the billing:usage:read permission. '
  + 'Running out of fal credits will not stop this seller advertising. '
  + 'To turn the check on, give the key that permission (fal presets BILLING, READONLY or FULL) and restart.';

const plugin: AntseedProviderPlugin = {
  name: 'fal-image',
  displayName: 'fal Image',
  version: '0.1.0-beta.0',
  type: 'provider',
  description: 'Sell fal.ai image models through the OpenAI Images API',
  configSchema: [
    { key: 'FAL_IMAGE_BASE_URL', label: 'fal URL', type: 'string', default: FAL_IMAGE_DEFAULT_BASE_URL },
    { key: 'FAL_IMAGE_API_KEY', label: 'fal API Key', type: 'secret', required: true },
    { key: 'ANTSEED_ALLOWED_SERVICES', label: 'Services', type: 'string[]', required: true },
    { key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON', label: 'Unit Pricing', type: 'string', required: true },
    { key: 'ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON', label: 'Edit Endpoints', type: 'string', description: 'JSON map of service → fal edit endpoint ID' },
    { key: 'ANTSEED_SERVICE_CAPABILITIES_JSON', label: 'Capabilities', type: 'string' },
    { key: 'ANTSEED_MAX_CONCURRENCY', label: 'Concurrency', type: 'number', default: 10 },
    {
      key: 'FAL_IMAGE_MIN_BALANCE_USD',
      label: 'Minimum Balance (USD)',
      type: 'number',
      default: 0,
      description: 'Stop advertising image models while the fal balance is at or below this amount. Needs FAL_IMAGE_API_KEY to have the billing:usage:read permission',
    },
  ],
  createProvider(config): Provider {
    const apiKey = config['FAL_IMAGE_API_KEY']?.trim();
    if (!apiKey) throw new Error('FAL_IMAGE_API_KEY is required');
    const baseUrl = (config['FAL_IMAGE_BASE_URL']?.trim() || FAL_IMAGE_DEFAULT_BASE_URL).replace(/\/+$/, '');
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('FAL_IMAGE_BASE_URL must be an HTTP(S) URL without credentials, query, or fragment');
    }
    if (config['ANTSEED_SERVICE_ALIAS_MAP_JSON']) throw new Error('fal image services must use fal endpoint IDs');

    const services = parseCsv(config['ANTSEED_ALLOWED_SERVICES']);
    if (services.length === 0) throw new Error('ANTSEED_ALLOWED_SERVICES is required');
    const isEndpoint = (id: string) => id.length <= 64 && ENDPOINT_ID.test(id);
    const invalid = services.find(service => !isEndpoint(service));
    if (invalid) throw new Error(`Invalid fal endpoint ID: ${invalid}`);
    const serviceUnitBillingModels = parseServiceUnitBillingModelsJson(config['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']);
    const missingPricing = services.find(service => !serviceUnitBillingModels?.[service]?.[PROTOCOL]);
    if (missingPricing) throw new Error(`Missing ${PROTOCOL} unit pricing for ${missingPricing}`);

    const editEndpoints = new Map<string, string>();
    const editMap = parseJsonObject(Buffer.from(config['ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON'] ?? '{}'));
    if (!editMap) throw new Error('ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON must be a JSON object');
    for (const [service, endpoint] of Object.entries(editMap)) {
      // Matched case-insensitively, as buyer routing matches services.
      const advertised = services.find(candidate => candidate.toLowerCase() === service.toLowerCase());
      if (!advertised) throw new Error(`fal edit endpoint configured for unknown service "${service}"`);
      if (typeof endpoint !== 'string' || !isEndpoint(endpoint)) throw new Error(`Invalid fal edit endpoint ID for ${service}`);
      editEndpoints.set(advertised, endpoint);
    }

    const maxConcurrency = Number(config['ANTSEED_MAX_CONCURRENCY'] ?? 10);
    if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('ANTSEED_MAX_CONCURRENCY must be a positive integer');
    const minBalanceUsd = Number(config['FAL_IMAGE_MIN_BALANCE_USD'] ?? 0);
    if (!Number.isFinite(minBalanceUsd) || minBalanceUsd < 0) throw new Error('FAL_IMAGE_MIN_BALANCE_USD must be a non-negative number');
    const configuredCapabilities = parseServiceCapabilitiesJson(config['ANTSEED_SERVICE_CAPABILITIES_JSON']);
    const authorization = `Key ${apiKey}`;

    const serviceCapabilities: Record<string, ServiceCapabilities> = Object.fromEntries(services.map(service => [service, {
      inputs: editEndpoints.has(service) ? ['text', 'image'] : ['text'],
      outputs: ['image'],
      ...configuredCapabilities?.[service],
    }]));
    // Endpoint ID → its schema; endpoints whose schema could not be read are missing.
    const schemas = new Map<string, FalImageSchema>();
    // Off once fal says the seller key can't read billing; the key's permissions don't change while running.
    let balanceCheck = true;

    // Announces the OpenAI fields each service takes, from its fal schema.
    const init = async () => {
      await Promise.all([...new Set([...services, ...editEndpoints.values()])].map(async endpoint => {
        try {
          const response = await fetch(`${FAL_SCHEMA_URL}?endpoint_id=${encodeURIComponent(endpoint)}`, { redirect: 'error', signal: AbortSignal.timeout(SCHEMA_TIMEOUT_MS) });
          const schema = response.ok ? falImageSchema(parseJsonObject(Buffer.from(await response.arrayBuffer())), endpoint) : null;
          if (schema) schemas.set(endpoint, schema);
        } catch {
          // Unknown input fields: every mapped field is sent, and fal rejects what it does not take.
        }
      }));
      for (const service of services) {
        const capabilities = serviceCapabilities[service]!;
        const schema = schemas.get(service);
        if (capabilities.supportedParameters || !schema) continue;
        const parameters = [
          'n', 'response_format', 'moderation', 'size',
          ...['quality', 'resolution', ...PASSTHROUGH_FIELDS].filter(field => schema.fields.has(field)),
          ...(editEndpoints.has(service) ? ['image'] : []),
        ].sort();
        if (validateServiceCapabilityFields({ supportedParameters: parameters }).length === 0) capabilities.supportedParameters = parameters;
      }
      const account = await readFalAccount(FAL_PLATFORM_URL, authorization);
      if (account.status === 'no_permission') {
        balanceCheck = false;
        console.warn(`[fal-image] ${FAL_IMAGE_BALANCE_CHECK_OFF}`);
      } else if (account.status === 'ok') {
        console.log(`[fal-image] fal balance check is on: $${account.balanceUsd.toFixed(2)}; models stop being advertised at or below $${minBalanceUsd}`);
      }
    };

    let active = 0;

    const run = async (request: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      const path = request.path.split('?', 1)[0]?.toLowerCase();
      const edit = path === EDITS_PATH;
      if (request.method.toUpperCase() !== 'POST' || (!edit && path !== GENERATIONS_PATH)) {
        throw new RequestError(404, `Unsupported image endpoint ${request.method} ${request.path}`);
      }
      const form = edit ? await readEditForm(request) : null;
      const fields: Record<string, unknown> | null = form ? form.fields : parseJsonObject(request.body);
      if (!fields) throw new RequestError(400, 'Image request must be a JSON object.');
      // The service the seller priced this request by; a routing header must name the same one.
      const named = typeof (fields.service ?? fields.model) === 'string' ? String(fields.service ?? fields.model).trim() : '';
      const service = services.find(candidate => candidate.toLowerCase() === named.toLowerCase());
      if (!service) throw new RequestError(400, `Unknown image model "${named}".`, 'model');
      const headerService = getHeader(request.headers, 'x-antseed-service').trim();
      if (headerService && headerService.toLowerCase() !== service.toLowerCase()) {
        throw new RequestError(400, `x-antseed-service "${headerService}" does not match the requested model "${service}".`, 'model');
      }
      const endpoint = edit ? editEndpoints.get(service) : service;
      if (!endpoint) throw new RequestError(400, `Model "${service}" does not support image edits.`, 'model');
      const schema = schemas.get(endpoint) ?? null;
      const input = falImageInput(fields, schema);
      if (form) {
        const takesList = !schema || schema.fields.has('image_urls');
        if (!takesList && !schema.fields.has('image_url')) throw new RequestError(400, 'This model takes no input image.', 'image');
        if (!takesList && form.images.length > 1) throw new RequestError(400, 'This model edits one image at a time.', 'image');
        const images = await Promise.all(form.images.map(dataUrl));
        if (takesList) input.image_urls = images;
        else input.image_url = images[0];
        if (form.mask) {
          if (schema && !schema.fields.has('mask_url')) throw new RequestError(400, 'This model does not take a mask.', 'mask');
          input.mask_url = await dataUrl(form.mask);
        }
      }

      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const upstream = await fetch(`${baseUrl}/${endpoint}`, {
        method: 'POST',
        headers: { authorization, 'content-type': 'application/json' },
        body: JSON.stringify(input),
        redirect: 'error',
        signal,
      });
      const body = await readBounded(upstream, MAX_RESULT_BYTES);
      const result = body ? parseJsonObject(body) : null;
      if (upstream.status >= 400 && upstream.status < 500) {
        return openAiError(request.requestId, upstream.status, falErrorReason(result) ?? `fal answered HTTP ${upstream.status}`);
      }
      const images = resultImages(result);
      if (!upstream.ok || images.length === 0) return openAiError(request.requestId, 502, 'fal returned no image');
      const responseFormat = fields.response_format === 'url' ? 'url' : 'b64_json';
      const data = await Promise.all(images.map(image => openAiImage(image, responseFormat, signal)));
      return {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: Buffer.from(JSON.stringify({ created: Math.floor(Date.now() / 1000), data })),
      };
    };

    const handleRequest: Provider['handleRequest'] = async (request) => {
      if (active >= maxConcurrency) return openAiError(request.requestId, 429, 'Max concurrency reached');
      active += 1;
      try {
        return await run(request);
      } catch (cause) {
        if (cause instanceof RequestError) return openAiError(request.requestId, cause.statusCode, cause.message, cause.param);
        if (cause instanceof Error && cause.name === 'TimeoutError') return openAiError(request.requestId, 504, 'fal did not finish the image in time');
        console.warn(`[fal-image] request failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        return openAiError(request.requestId, 502, 'Could not get the image from fal');
      } finally {
        active -= 1;
      }
    };

    return {
      name: 'fal-image',
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
        const endpoints = [...new Set(checked.flatMap(service => [service, ...(editEndpoints.has(service) ? [editEndpoints.get(service)!] : [])]))];
        const statuses = await readFalModelStatuses(FAL_PLATFORM_URL, authorization, endpoints);
        return Object.fromEntries(checked.map((service): [string, ServiceHealthStatus] => {
          if (!statuses) return [service, { status: 'unknown', reason: 'fal model list unavailable' }];
          for (const endpoint of [service, editEndpoints.get(service)].filter((id): id is string => !!id)) {
            const status = statuses.get(endpoint);
            if (!status) return [service, { status: 'unavailable', reason: `fal no longer offers ${endpoint}` }];
            if (status !== 'active' && status !== 'deprecated') return [service, { status: 'unavailable', reason: `fal reports ${endpoint} ${status}` }];
          }
          return [service, { status: 'available' }];
        }));
      },
      async checkUpstreamAccount(): Promise<UpstreamAccountStatus> {
        if (!balanceCheck) return { status: 'unknown', reason: 'fal balance check is off (key lacks billing:usage:read)' };
        const account = await readFalAccount(FAL_PLATFORM_URL, authorization);
        if (account.status === 'no_permission') {
          balanceCheck = false;
          console.warn(`[fal-image] ${FAL_IMAGE_BALANCE_CHECK_OFF}`);
          return { status: 'unknown', reason: 'fal balance check is off (key lacks billing:usage:read)' };
        }
        if (account.status === 'rejected') return { status: 'unavailable', reason: account.reason };
        if (account.status === 'unknown') return account;
        if (account.balanceUsd <= minBalanceUsd) {
          return { status: 'unavailable', reason: `fal balance $${account.balanceUsd.toFixed(2)} is at or below the $${minBalanceUsd} minimum`, outOfCredit: true };
        }
        return { status: 'available', balanceUsd: account.balanceUsd };
      },
    };
  },
};

export default plugin;

import type {
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node';
import { requestBodyFields } from '@antseed/node';
import { getHeader, openAiError, withPinnedUpstreamModel } from '@antseed/provider-core';

const OPENAI_IMAGE_EDIT_PATH = '/v1/images/edits';
const VENICE_IMAGE_EDIT_PATH = '/v1/image/edit';
/** Venice's edit of several images: the first is the base, the rest are layers or references. */
const VENICE_IMAGE_MULTI_EDIT_PATH = '/v1/image/multi-edit';
const VENICE_EDIT_PARAMETERS = [
  'aspect_ratio',
  'disable_prompt_optimization_thinking',
  'enhance_prompt',
  'output_format',
  'quality',
  'resolution',
  'safe_mode',
] as const;
/** OpenAI clients send several images as repeated `image[]` parts, one image as `image`. */
const IMAGE_FIELDS = ['image', 'image[]'] as const;
const IMAGE_FIELD_NAMES = new Set<string>(IMAGE_FIELDS);
const OPENAI_IMAGE_EDIT_FIELDS = new Set([
  'model',
  'service',
  'prompt',
  ...IMAGE_FIELDS,
  'mask',
  'n',
  'response_format',
  'moderation',
  ...VENICE_EDIT_PARAMETERS,
]);

type AdaptRequestResult =
  | { adapted: SerializedHttpRequest }
  | { response: SerializedHttpResponse };

function replaceHeader(
  headers: Record<string, string>,
  name: string,
  value: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, headerValue] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower !== name.toLowerCase() && lower !== 'content-length') {
      out[key] = headerValue;
    }
  }
  out[name] = value;
  return out;
}

function textField(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function isImageEditRequest(request: SerializedHttpRequest): boolean {
  return request.path.split('?', 1)[0]?.toLowerCase() === OPENAI_IMAGE_EDIT_PATH;
}

function appendBlob(form: FormData, name: string, value: Blob): void {
  const fileName = 'name' in value && typeof value.name === 'string' && value.name.trim()
    ? value.name
    : 'image';
  form.append(name, value, fileName);
}

async function adaptRequest(
  request: SerializedHttpRequest,
  editModelMap: Readonly<Record<string, string>>,
): Promise<AdaptRequestResult> {
  const reject = (statusCode: number, message: string, param?: string): AdaptRequestResult => ({
    response: openAiError(request.requestId, statusCode, message, param),
  });

  if (request.method.toUpperCase() !== 'POST') {
    return reject(405, 'Image edits require POST.');
  }

  const contentType = getHeader(request.headers, 'content-type');
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return reject(415, 'Venice image edits require multipart/form-data.');
  }

  let form: FormData;
  try {
    form = await new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: request.body,
    }).formData();
  } catch {
    return reject(400, 'Invalid multipart image edit request.');
  }

  for (const field of form.keys()) {
    if (!OPENAI_IMAGE_EDIT_FIELDS.has(field)) {
      return reject(400, `Venice image edits do not support the "${field}" field.`, field);
    }
  }

  // The seller priced this request from its own reading of the text fields, which
  // skips oversized ones and keeps the first of a name. Anything it read
  // differently (a padded quality, a repeated field) could buy a dearer edit than
  // the one billed, so it is refused.
  const billed = requestBodyFields(request) ?? {};
  for (const [field, value] of form.entries()) {
    if (typeof value === 'string' && billed[field] !== value) {
      return reject(400, `The "${field}" field is too long or repeated.`, field);
    }
  }

  // The service the seller priced and bills this request by (the fields above match
  // the seller's reading); a routing header must name the same service, so an edit
  // never runs another (possibly dearer) service's edit model.
  const named = billed['service'] ?? billed['model'];
  const requestedService = typeof named === 'string' ? named.trim() : '';
  if (!requestedService) {
    return reject(400, 'Image edit model is required.', 'model');
  }
  const headerService = getHeader(request.headers, 'x-antseed-service').trim();
  if (headerService && headerService.toLowerCase() !== requestedService.toLowerCase()) {
    return reject(400, `x-antseed-service "${headerService}" does not match the requested model "${requestedService}".`, 'model');
  }

  const editModel = editModelMap[requestedService.toLowerCase()];
  if (!editModel) {
    return reject(
      400,
      `Service "${requestedService}" does not have a Venice image edit model configured.`,
      'model',
    );
  }

  const prompt = textField(form, 'prompt');
  if (!prompt) {
    return reject(400, 'Image edit prompt is required.', 'prompt');
  }

  // In form order: Venice takes the first image as the base, whatever its field name.
  const entries = [...form.entries()].flatMap(([field, value]) => (IMAGE_FIELD_NAMES.has(field) ? [value] : []));
  // A text part under an image field is refused below rather than skipped.
  const images = entries.filter((value) => typeof value !== 'string');
  if (images.length === 0 || images.length !== entries.length) {
    return reject(400, 'Venice image edits require one or more image files.', 'image');
  }
  if (form.has('mask')) {
    return reject(400, 'Venice image edits do not support the OpenAI mask field.', 'mask');
  }

  const count = textField(form, 'n');
  if (count && count !== '1') {
    return reject(400, 'Venice image edits support only n=1.', 'n');
  }

  const responseFormat = textField(form, 'response_format') || 'b64_json';
  if (responseFormat !== 'b64_json') {
    return reject(400, 'Venice image edits support only response_format="b64_json".', 'response_format');
  }

  // Venice's single-image edit takes no `quality`; its multi-image edit does,
  // and names the images `images` and the model `modelId`.
  const multi = images.length > 1 || textField(form, 'quality') !== '';
  const upstreamForm = new FormData();
  for (const image of images) appendBlob(upstreamForm, multi ? 'images' : 'image', image);
  upstreamForm.append('prompt', prompt);
  upstreamForm.append(multi ? 'modelId' : 'model', editModel);
  for (const parameter of VENICE_EDIT_PARAMETERS) {
    const value = textField(form, parameter);
    if (value) upstreamForm.append(parameter, value);
  }
  const moderation = textField(form, 'moderation');
  if (moderation && moderation !== 'low' && moderation !== 'auto') {
    return reject(400, 'moderation must be "auto" or "low".', 'moderation');
  }
  if (moderation && upstreamForm.has('safe_mode')) {
    return reject(400, 'moderation and safe_mode cannot both be provided.', 'moderation');
  }
  if (!upstreamForm.has('safe_mode')) {
    if (moderation === 'low') {
      upstreamForm.append('safe_mode', 'false');
    } else if (moderation === 'auto') {
      upstreamForm.append('safe_mode', 'true');
    }
  }

  const encoded = new Response(upstreamForm);
  const upstreamContentType = encoded.headers.get('content-type');
  if (!upstreamContentType) {
    return reject(500, 'Could not encode Venice image edit request.');
  }

  // The relay keeps selecting upstreams (and fallbacks) by the advertised
  // service, which the rebuilt form no longer names, so it travels in the
  // header; only the model sent upstream is the native edit model.
  const headers = replaceHeader(request.headers, 'content-type', upstreamContentType);
  return {
    adapted: withPinnedUpstreamModel({
      ...request,
      path: multi ? VENICE_IMAGE_MULTI_EDIT_PATH : VENICE_IMAGE_EDIT_PATH,
      headers: replaceHeader(headers, 'x-antseed-service', requestedService),
      body: new Uint8Array(await encoded.arrayBuffer()),
    }, editModel),
  };
}

function normalizedErrorResponse(response: SerializedHttpResponse): SerializedHttpResponse {
  const contentType = getHeader(response.headers, 'content-type');
  if (!contentType.toLowerCase().includes('application/json')) return response;

  try {
    const payload = JSON.parse(new TextDecoder().decode(response.body)) as Record<string, unknown>;
    if (payload.error && typeof payload.error === 'object') return response;
    if (typeof payload.error !== 'string' || !payload.error.trim()) return response;
    return {
      ...response,
      body: new TextEncoder().encode(JSON.stringify({
        ...payload,
        error: {
          message: payload.error,
          type: 'upstream_error',
        },
      })),
    };
  } catch {
    return response;
  }
}

function decodeEnhancedPrompt(response: SerializedHttpResponse): string | undefined {
  const raw = getHeader(response.headers, 'x-venice-enhanced-prompt');
  if (!raw) return undefined;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function adaptResponse(
  response: SerializedHttpResponse,
): SerializedHttpResponse {
  if (response.statusCode < 200 || response.statusCode >= 300) {
    return normalizedErrorResponse(response);
  }

  const contentType = getHeader(response.headers, 'content-type').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!contentType.startsWith('image/')) {
    return openAiError(
      response.requestId,
      502,
      'Venice image edit returned a successful response without image data.',
    );
  }

  const base64 = Buffer.from(response.body).toString('base64');
  const revisedPrompt = decodeEnhancedPrompt(response);
  const image = { b64_json: base64, ...(revisedPrompt ? { revised_prompt: revisedPrompt } : {}) };
  const headers = replaceHeader(response.headers, 'content-type', 'application/json');
  return {
    ...response,
    headers,
    body: new TextEncoder().encode(JSON.stringify({
      created: Math.floor(Date.now() / 1000),
      data: [image],
    })),
  };
}

export class VeniceImageEditProvider implements Provider {
  readonly name: string;
  readonly services: string[];
  readonly pricing: Provider['pricing'];
  readonly serviceApiProtocols: Provider['serviceApiProtocols'];
  readonly serviceUnitBillingModels: Provider['serviceUnitBillingModels'];
  readonly serviceCapabilities: Provider['serviceCapabilities'];
  readonly maxConcurrency: number;
  serviceCategories?: Provider['serviceCategories'];

  constructor(
    private readonly delegate: Provider,
    private readonly editModelMap: Readonly<Record<string, string>>,
    private readonly afterInit?: () => Promise<void>,
  ) {
    this.name = delegate.name;
    this.services = delegate.services;
    this.pricing = delegate.pricing;
    this.serviceApiProtocols = delegate.serviceApiProtocols;
    this.serviceUnitBillingModels = delegate.serviceUnitBillingModels;
    this.serviceCapabilities = delegate.serviceCapabilities;
    this.maxConcurrency = delegate.maxConcurrency;
    this.serviceCategories = delegate.serviceCategories;
  }

  async init(): Promise<void> {
    await this.delegate.init?.();
    await this.afterInit?.();
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (!isImageEditRequest(request)) {
      return this.delegate.handleRequest(request);
    }

    const result = await adaptRequest(request, this.editModelMap);
    if ('response' in result) return result.response;
    const response = await this.delegate.handleRequest(result.adapted);
    return adaptResponse(response);
  }

  async handleRequestStream(
    request: SerializedHttpRequest,
    callbacks: ProviderStreamCallbacks,
  ): Promise<SerializedHttpResponse> {
    if (!isImageEditRequest(request) && this.delegate.handleRequestStream) {
      return this.delegate.handleRequestStream(request, callbacks);
    }
    return this.handleRequest(request);
  }

  getCapacity(): { current: number; max: number } {
    return this.delegate.getCapacity();
  }
}

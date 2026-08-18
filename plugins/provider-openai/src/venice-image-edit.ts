import type {
  Provider,
  ProviderStreamCallbacks,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/node';

const OPENAI_IMAGE_EDIT_PATH = '/v1/images/edits';
const VENICE_IMAGE_EDIT_PATH = '/v1/image/edit';
const VENICE_EDIT_PARAMETERS = [
  'aspect_ratio',
  'disable_prompt_optimization_thinking',
  'enhance_prompt',
  'output_format',
  'quality',
  'resolution',
  'safe_mode',
] as const;
const OPENAI_IMAGE_EDIT_FIELDS = new Set([
  'model',
  'service',
  'prompt',
  'image',
  'mask',
  'n',
  'response_format',
  'moderation',
  ...VENICE_EDIT_PARAMETERS,
]);

type AdaptedRequest = {
  request: SerializedHttpRequest;
};

type AdaptRequestResult =
  | { adapted: AdaptedRequest }
  | { response: SerializedHttpResponse };

function getHeader(headers: Record<string, string>, name: string): string {
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? '';
}

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

function openAiError(
  requestId: string,
  statusCode: number,
  message: string,
  param?: string,
): SerializedHttpResponse {
  return {
    requestId,
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      error: {
        message,
        type: statusCode >= 500 ? 'upstream_error' : 'invalid_request_error',
        ...(param ? { param } : {}),
      },
    })),
  };
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
  if (request.method.toUpperCase() !== 'POST') {
    return { response: openAiError(request.requestId, 405, 'Image edits require POST.') };
  }

  const contentType = getHeader(request.headers, 'content-type');
  if (!/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return {
      response: openAiError(
        request.requestId,
        415,
        'Venice image edits require multipart/form-data.',
      ),
    };
  }

  let form: FormData;
  try {
    form = await new Request('http://localhost', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body: request.body,
    }).formData();
  } catch {
    return {
      response: openAiError(request.requestId, 400, 'Invalid multipart image edit request.'),
    };
  }

  for (const field of form.keys()) {
    if (!OPENAI_IMAGE_EDIT_FIELDS.has(field)) {
      return {
        response: openAiError(
          request.requestId,
          400,
          `Venice image edits do not support the "${field}" field.`,
          field,
        ),
      };
    }
  }

  const requestedService = getHeader(request.headers, 'x-antseed-service').trim()
    || textField(form, 'service')
    || textField(form, 'model');
  if (!requestedService) {
    return {
      response: openAiError(request.requestId, 400, 'Image edit model is required.', 'model'),
    };
  }

  const editModel = editModelMap[requestedService.toLowerCase()];
  if (!editModel) {
    return {
      response: openAiError(
        request.requestId,
        400,
        `Service "${requestedService}" does not have a Venice image edit model configured.`,
        'model',
      ),
    };
  }

  const prompt = textField(form, 'prompt');
  if (!prompt) {
    return {
      response: openAiError(request.requestId, 400, 'Image edit prompt is required.', 'prompt'),
    };
  }

  const images = form.getAll('image');
  if (images.length !== 1 || !(images[0] instanceof Blob)) {
    return {
      response: openAiError(
        request.requestId,
        400,
        'Venice single-image edits require exactly one image file.',
        'image',
      ),
    };
  }
  if (form.has('mask')) {
    return {
      response: openAiError(
        request.requestId,
        400,
        'Venice single-image edits do not support the OpenAI mask field.',
        'mask',
      ),
    };
  }

  const count = textField(form, 'n');
  if (count && count !== '1') {
    return {
      response: openAiError(
        request.requestId,
        400,
        'Venice single-image edits support only n=1.',
        'n',
      ),
    };
  }

  const responseFormat = textField(form, 'response_format') || 'b64_json';
  if (responseFormat !== 'b64_json') {
    return {
      response: openAiError(
        request.requestId,
        400,
        'Venice image edits support only response_format="b64_json".',
        'response_format',
      ),
    };
  }

  const upstreamForm = new FormData();
  appendBlob(upstreamForm, 'image', images[0]);
  upstreamForm.append('prompt', prompt);
  upstreamForm.append('model', editModel);
  for (const parameter of VENICE_EDIT_PARAMETERS) {
    const value = textField(form, parameter);
    if (value) upstreamForm.append(parameter, value);
  }
  const moderation = textField(form, 'moderation');
  if (moderation && moderation !== 'low' && moderation !== 'auto') {
    return {
      response: openAiError(
        request.requestId,
        400,
        'moderation must be "auto" or "low".',
        'moderation',
      ),
    };
  }
  if (moderation && upstreamForm.has('safe_mode')) {
    return {
      response: openAiError(
        request.requestId,
        400,
        'moderation and safe_mode cannot both be provided.',
        'moderation',
      ),
    };
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
    return { response: openAiError(request.requestId, 500, 'Could not encode Venice image edit request.') };
  }

  const headers = replaceHeader(request.headers, 'content-type', upstreamContentType);
  const routedHeaders = replaceHeader(headers, 'x-antseed-service', editModel);
  return {
    adapted: {
      request: {
        ...request,
        path: VENICE_IMAGE_EDIT_PATH,
        headers: routedHeaders,
        body: new Uint8Array(await encoded.arrayBuffer()),
      },
    },
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
  }

  async handleRequest(request: SerializedHttpRequest): Promise<SerializedHttpResponse> {
    if (!isImageEditRequest(request)) {
      return this.delegate.handleRequest(request);
    }

    const result = await adaptRequest(request, this.editModelMap);
    if ('response' in result) return result.response;
    const response = await this.delegate.handleRequest(result.adapted.request);
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

import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';
import {
  normalizeAnthropicMessagesRequestBody,
  normalizeOpenAIChatRequestBody,
  normalizeOpenAIResponsesRequestBody,
  renderCanonicalRequestToAnthropicMessagesBody,
  renderCanonicalRequestToOpenAIChatBody,
  renderCanonicalRequestToOpenAIResponsesBody,
  type CanonicalLlmRequest,
} from './canonical.js';
import {
  encodeJson,
  openAIResponsesFunctionCallId,
  openAIResponsesMessageId,
  parseJsonObject,
} from './utils.js';

export interface ServiceApiRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
}

export interface ServiceApiRequestTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  streamRequested?: boolean;
}

const CLIENT_STREAM_REQUESTED_HEADER = 'x-antseed-client-stream-requested';
const LEGACY_RESPONSES_MESSAGE_ID_SUFFIX = '_msg_1';

type RequestNormalizer = (body: Record<string, unknown>) => CanonicalLlmRequest;
type RequestRenderer = (
  request: CanonicalLlmRequest,
  options: ServiceApiRequestTransformOptions,
) => Record<string, unknown>;

const REQUEST_NORMALIZERS: Partial<Record<ServiceApiProtocol, RequestNormalizer>> = {
  'anthropic-messages': normalizeAnthropicMessagesRequestBody,
  'openai-chat-completions': normalizeOpenAIChatRequestBody,
  'openai-responses': normalizeOpenAIResponsesRequestBody,
};

const REQUEST_RENDERERS: Partial<Record<ServiceApiProtocol, RequestRenderer>> = {
  'anthropic-messages': (request) => renderCanonicalRequestToAnthropicMessagesBody(request),
  'openai-chat-completions': (request, options) => renderCanonicalRequestToOpenAIChatBody(
    request,
    {
      toolCallContent: options.from === 'openai-responses' ? null : undefined,
      groupAssistantToolCallsWithPreviousMessage: options.from === 'anthropic-messages',
      preserveResponsesAgentSemantics: options.from === 'openai-responses',
    },
  ),
  'openai-responses': (request, options) => renderCanonicalRequestToOpenAIResponsesBody(
    request,
    {
      includeMetadata: options.from !== 'anthropic-messages',
      includeUser: options.from !== 'anthropic-messages',
    },
  ),
};

const TARGET_PATHS: Partial<Record<ServiceApiProtocol, string>> = {
  'anthropic-messages': '/v1/messages',
  'openai-chat-completions': '/v1/chat/completions',
  'openai-responses': '/v1/responses',
};

export function transformRequest(
  request: SerializedHttpRequest,
  options: ServiceApiRequestTransformOptions,
): ServiceApiRequestTransformResult | null {
  const normalize = REQUEST_NORMALIZERS[options.from];
  const path = TARGET_PATHS[options.to];
  if (!normalize || !path) return null;

  const body = parseJsonObject(request.body);
  if (!body) return null;

  const normalized = normalize(body);
  const streamRequested = options.streamRequested ?? normalized.stream;
  if (options.from === options.to) {
    const repairedBody = options.from === 'openai-responses'
      ? repairLegacyResponsesItemIds(body)
      : null;
    return {
      request: repairedBody ? { ...request, body: encodeJson(repairedBody) } : request,
      streamRequested,
      requestedModel: normalized.model,
    };
  }

  const render = REQUEST_RENDERERS[options.to];
  if (!render) return null;
  const requestForRender = streamRequested === normalized.stream
    ? normalized
    : { ...normalized, stream: streamRequested };
  const transformedBody = render(requestForRender, options);
  const transformedHeaders = headersForTargetProtocol(request.headers, options.to);
  if (options.to === 'openai-responses') {
    transformedBody.stream = true;
    transformedHeaders[CLIENT_STREAM_REQUESTED_HEADER] = streamRequested ? 'true' : 'false';
  }

  return {
    request: {
      ...request,
      path,
      headers: transformedHeaders,
      body: encodeJson(transformedBody),
    },
    streamRequested,
    requestedModel: normalized.model,
  };
}

function repairLegacyResponsesItemIds(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  let changed = false;
  const input = body.input.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== 'string') return item;

    let repairedId: string | null = null;
    if (record.type === 'function_call' && !record.id.startsWith('fc_')) {
      repairedId = openAIResponsesFunctionCallId(record.id);
    } else if (
      (record.type === 'message' || record.type === 'item_reference')
      && !record.id.startsWith('msg_')
      && record.id.endsWith(LEGACY_RESPONSES_MESSAGE_ID_SUFFIX)
    ) {
      const responseId = record.id.slice(0, -LEGACY_RESPONSES_MESSAGE_ID_SUFFIX.length);
      if (responseId.length > 0) repairedId = openAIResponsesMessageId(responseId);
    } else if (
      record.type === 'item_reference'
      && (record.id.startsWith('call_') || record.id.startsWith('tool_'))
    ) {
      repairedId = openAIResponsesFunctionCallId(record.id);
    }

    if (!repairedId) return item;
    changed = true;
    return { ...record, id: repairedId };
  });

  return changed ? { ...body, input } : null;
}

function headersForTargetProtocol(
  headers: Record<string, string>,
  targetProtocol: ServiceApiProtocol,
): Record<string, string> {
  const transformedHeaders: Record<string, string> = { ...headers };
  for (const headerName of Object.keys(transformedHeaders)) {
    const lower = headerName.toLowerCase();
    if (lower === 'anthropic-beta') delete transformedHeaders[headerName];
    if (targetProtocol !== 'anthropic-messages' && lower === 'anthropic-version') {
      delete transformedHeaders[headerName];
    }
  }

  if (targetProtocol === 'anthropic-messages' && !hasHeader(transformedHeaders, 'anthropic-version')) {
    transformedHeaders['anthropic-version'] = '2023-06-01';
  }
  transformedHeaders['content-type'] = 'application/json';
  return transformedHeaders;
}

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const normalizedName = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalizedName);
}

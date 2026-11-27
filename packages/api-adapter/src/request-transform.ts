import type { SerializedHttpRequest, ServiceApiProtocol } from './types.js';
import {
  normalizeAnthropicMessagesRequestBody,
  normalizeOpenAIChatRequestBody,
  normalizeOpenAIResponsesRequestBody,
  renderCanonicalRequestToAnthropicMessagesBody,
  renderCanonicalRequestToOpenAIChatBody,
  renderCanonicalRequestToOpenAIResponsesBody,
  namespacedToolNames,
  type CanonicalLlmRequest,
  type NamespacedToolNames,
} from './canonical.js';
import {
  encodeJson,
  isAdapterReasoningItem,
  openAIResponsesFunctionCallId,
  RESPONSES_REASONING_TAG,
  openAIResponsesMessageId,
  parseJsonObject,
} from './utils.js';

export interface ServiceApiRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
  /**
   * The client keeps reasoning state: a Responses request whose `include` lists
   * `reasoning.encrypted_content`. Pass it to `createStreamingAdapter` and `transformResponse`, which
   * then return a chat model's reasoning to it as a `reasoning` item.
   */
  includeReasoning: boolean;
  /**
   * The functions flattened out of the request's `namespace` tools, by the name the seller sees. Pass it to
   * `createStreamingAdapter` and `transformResponse`, which then return a call to one of them to a Responses
   * client with the tool's own name and its `namespace`, as the client defined it.
   */
  namespacedTools: NamespacedToolNames;
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
      groupAssistantToolCallsWithPreviousMessage: groupsAssistantToolCalls(options.from),
      // A model's own earlier reasoning, which a Responses client returns, goes back to it (see
      // normalizeOpenAIResponsesRequestBody); a plain rendering of the request leaves it out.
      reasoningContent: options.from === 'openai-responses',
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
      includeReasoning: requestsReasoningState(options.from, body),
      namespacedTools: {},
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
    includeReasoning: requestsReasoningState(options.from, body),
    namespacedTools: namespacedToolNames(normalized),
  };
}

function requestsReasoningState(from: ServiceApiProtocol, body: Record<string, unknown>): boolean {
  return from === 'openai-responses' && Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
}

/**
 * Render a Chat Completions, Anthropic Messages or Responses request body as a plain
 * OpenAI Chat Completions body, using the same normalizers and message grouping as
 * `transformRequest`. Returns null for unsupported protocols.
 */
export function renderRequestBodyAsOpenAIChat(
  from: ServiceApiProtocol,
  body: Record<string, unknown>,
): Record<string, unknown> | null {
  if (from === 'openai-chat-completions') return structuredClone(body);
  const normalize = REQUEST_NORMALIZERS[from];
  if (!normalize) return null;
  return renderCanonicalRequestToOpenAIChatBody(normalize(body), {
    groupAssistantToolCallsWithPreviousMessage: groupsAssistantToolCalls(from),
  });
}

/**
 * Anthropic and Responses send an assistant's text and the tool calls it introduces as
 * separate blocks or items. Chat Completions holds them in one assistant message; sent as
 * two, the text reads as a reply that ended without acting.
 */
function groupsAssistantToolCalls(from: ServiceApiProtocol): boolean {
  return from === 'anthropic-messages' || from === 'openai-responses';
}

function repairLegacyResponsesItemIds(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  let changed = false;
  // See withoutAdapterReasoningItems.
  const kept = body.input.filter((item) => !isAdapterReasoningInput(item));
  if (kept.length !== body.input.length) changed = true;
  const input = kept.map((item) => {
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

/**
 * A Responses request for a Responses seller, without the reasoning items this adapter made from a
 * chat model's reasoning in earlier turns: no provider can resolve their `encrypted_content`. Every
 * other item stays as it is (a `content-length` follows the new body), and a request with none of
 * them is returned unchanged.
 */
export function withoutAdapterReasoningItems(request: SerializedHttpRequest): SerializedHttpRequest {
  if (!new TextDecoder().decode(request.body).includes(RESPONSES_REASONING_TAG)) return request;
  const body = parseJsonObject(request.body);
  if (!body || !Array.isArray(body.input)) return request;
  const input = body.input.filter((item) => !isAdapterReasoningInput(item));
  if (input.length === body.input.length) return request;
  const rewritten = encodeJson({ ...body, input });
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'content-length') headers[name] = String(rewritten.length);
  }
  return { ...request, headers, body: rewritten };
}

function isAdapterReasoningInput(item: unknown): boolean {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item) && isAdapterReasoningItem(item as Record<string, unknown>);
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

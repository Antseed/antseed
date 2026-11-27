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
  isAdapterReasoningItem,
  openAIResponsesFunctionCallId,
  ADAPTER_REASONING_TAG,
  openAIResponsesMessageId,
  parseJsonObject,
} from './utils.js';

export interface ServiceApiRequestTransformResult {
  request: SerializedHttpRequest;
  streamRequested: boolean;
  requestedModel: string | null;
  /**
   * The client asked for the model's reasoning: a Responses request whose `include` lists
   * `reasoning.encrypted_content` (it keeps reasoning state), a Chat Completions request that names a
   * `reasoning_effort` other than `none`, or a Messages request that switches `thinking` on (`enabled` or
   * `adaptive`). Pass it to `createStreamingAdapter` and `transformResponse`, which then return the
   * reasoning as a `reasoning` item, `reasoning_content` or a `thinking` block, and leave out reasoning a
   * seller wrote on its own for a client that did not ask.
   */
  includeReasoning: boolean;
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
      // A model's own earlier reasoning, which a Responses or Messages client returns, goes back to it
      // (see normalizeOpenAIResponsesRequestBody, adapterThinkingTextFor); a plain rendering leaves it out.
      reasoningContent: true,
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
  };
}

function requestsReasoningState(from: ServiceApiProtocol, body: Record<string, unknown>): boolean {
  if (from === 'openai-responses') return Array.isArray(body.include) && body.include.includes('reasoning.encrypted_content');
  if (from === 'openai-chat-completions') return typeof body.reasoning_effort === 'string' && body.reasoning_effort !== 'none';
  return requestsThinking(body);
}

/** Whether a Messages request switches thinking on, with a budget (`enabled`) or without one (`adaptive`). */
function requestsThinking(body: Record<string, unknown>): boolean {
  const thinking = body.thinking;
  if (!thinking || typeof thinking !== 'object' || Array.isArray(thinking)) return false;
  const type = (thinking as Record<string, unknown>).type;
  return type === 'enabled' || type === 'adaptive';
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
  if (!new TextDecoder().decode(request.body).includes(ADAPTER_REASONING_TAG)) return request;
  const body = parseJsonObject(request.body);
  if (!body || !Array.isArray(body.input)) return request;
  const input = body.input.filter((item) => !isAdapterReasoningInput(item));
  if (input.length === body.input.length) return request;
  return withBody(request, { ...body, input });
}

function isAdapterReasoningInput(item: unknown): boolean {
  return Boolean(item) && typeof item === 'object' && !Array.isArray(item) && isAdapterReasoningItem(item as Record<string, unknown>);
}

/**
 * A Messages request for a Messages seller, without the `thinking` blocks this adapter made from a
 * chat model's reasoning in earlier turns: their `signature` is the adapter's tag, which the seller
 * would reject. Unsigned and provider-signed blocks stay, an assistant message left with no blocks is
 * dropped, and a request with none of them is returned unchanged.
 */
export function withoutAdapterThinkingBlocks(request: SerializedHttpRequest): SerializedHttpRequest {
  if (!new TextDecoder().decode(request.body).includes(ADAPTER_REASONING_TAG)) return request;
  const body = parseJsonObject(request.body);
  if (!body || !Array.isArray(body.messages)) return request;
  let removed = false;
  const messages = body.messages.flatMap((message: unknown) => {
    if (!message || typeof message !== 'object' || !Array.isArray((message as Record<string, unknown>).content)) return [message];
    const content = ((message as Record<string, unknown>).content as unknown[]).filter((block) => !isAdapterThinkingBlock(block));
    if (content.length === ((message as Record<string, unknown>).content as unknown[]).length) return [message];
    removed = true;
    return content.length > 0 ? [{ ...message, content }] : [];
  });
  return removed ? withBody(request, { ...body, messages }) : request;
}

function isAdapterThinkingBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object') return false;
  const { type, signature } = block as Record<string, unknown>;
  return type === 'thinking' && typeof signature === 'string' && signature.startsWith(ADAPTER_REASONING_TAG);
}

/** The request with a new JSON body; a `content-length` follows it. */
function withBody(request: SerializedHttpRequest, body: Record<string, unknown>): SerializedHttpRequest {
  const rewritten = encodeJson(body);
  const headers = { ...request.headers };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === 'content-length') headers[name] = String(rewritten.length);
  }
  return { ...request, headers, body: rewritten };
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

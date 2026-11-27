import type { SerializedHttpResponse, ServiceApiProtocol } from './types.js';
import {
  normalizeAnthropicMessagesResponseBody,
  normalizeOpenAIChatResponseBody,
  normalizeOpenAIResponsesResponseBody,
  renderCanonicalResponseToAnthropicMessagesBody,
  renderCanonicalResponseToOpenAIChatBody,
  renderCanonicalResponseToOpenAIResponsesBody,
  type CanonicalLlmResponse,
} from './canonical.js';
import { encodeJson, encodeText, parseJsonObject, reasoningUsageFields, type ReportedUsage } from './utils.js';

export interface ServiceApiResponseTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  streamRequested?: boolean;
  fallbackModel?: string | null;
  /** A Responses client that keeps reasoning state gets a chat model's reasoning (see `includeReasoning` on transformRequest). */
  includeReasoning?: boolean;
}

type ResponseNormalizer = (
  body: Record<string, unknown>,
  fallbacks: { id: string; model: string; requestedModel?: string | null },
) => CanonicalLlmResponse;
type ResponseRenderer = (response: CanonicalLlmResponse) => Record<string, unknown>;

const RESPONSE_NORMALIZERS: Partial<Record<ServiceApiProtocol, ResponseNormalizer>> = {
  'anthropic-messages': normalizeAnthropicMessagesResponseBody,
  'openai-chat-completions': normalizeOpenAIChatResponseBody,
  'openai-responses': normalizeOpenAIResponsesResponseBody,
};

const RESPONSE_RENDERERS: Partial<Record<ServiceApiProtocol, ResponseRenderer>> = {
  'anthropic-messages': renderCanonicalResponseToAnthropicMessagesBody,
  'openai-chat-completions': renderCanonicalResponseToOpenAIChatBody,
  'openai-responses': renderCanonicalResponseToOpenAIResponsesBody,
};

export function transformResponse(
  response: SerializedHttpResponse,
  options: ServiceApiResponseTransformOptions,
): SerializedHttpResponse | null {
  if (options.from === options.to) return response;

  const normalize = RESPONSE_NORMALIZERS[options.from];
  const render = RESPONSE_RENDERERS[options.to];
  if (!normalize || !render) return null;

  const parsed = parseJsonObject(response.body);
  if (!parsed) return response;

  if (response.statusCode >= 400) {
    return transformErrorResponse(response, parsed, options);
  }

  const normalized = normalize(parsed, {
    id: fallbackResponseId(response.requestId, options.to),
    model: options.fallbackModel ?? 'unknown',
    requestedModel: options.fallbackModel ?? null,
  });
  const { reasoning: _reasoning, reasoningModel: _reasoningModel, ...withoutReasoning } = normalized;
  const canonical: CanonicalLlmResponse = options.includeReasoning === true ? normalized : withoutReasoning;
  const body = render(canonical);

  if (options.streamRequested) {
    return {
      ...response,
      headers: streamHeaders(response.headers),
      body: renderCanonicalResponseStream(options.to, body, canonical),
    };
  }

  return {
    ...response,
    headers: jsonHeaders(response.headers),
    body: encodeJson(body),
  };
}

/**
 * A seller's error status is the answer before any output, so it stays a
 * plain HTTP error with a JSON body even when the client asked for a stream:
 * SDKs read JSON on a non-2xx, as the real APIs send. An error after output
 * started is the stream adapter's, in the stream.
 */
function transformErrorResponse(
  response: SerializedHttpResponse,
  parsed: Record<string, unknown>,
  options: ServiceApiResponseTransformOptions,
): SerializedHttpResponse {
  const body = options.to === 'anthropic-messages'
    ? { type: 'error', error: { type: 'api_error', message: extractErrorMessage(parsed) } }
    : { error: normalizeOpenAIError(parsed) };
  return {
    ...response,
    headers: jsonHeaders(response.headers),
    body: encodeJson(body),
  };
}

/**
 * A seller error that arrived as an event stream before any output (an error
 * status with a `text/event-stream` body), rewritten as `protocol`'s JSON
 * error body. Reads a chat `data: {"error":…}` frame, a Responses `error`
 * event or failed response, and an Anthropic `error` event; a stream with no
 * readable error still becomes JSON, with its text as the message. Any other
 * response is returned as is.
 */
export function errorEventStreamAsJson(
  response: SerializedHttpResponse,
  protocol: ServiceApiProtocol,
): SerializedHttpResponse {
  if (response.statusCode < 400) return response;
  const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  if (!contentType?.toLowerCase().includes('text/event-stream')) return response;

  const text = new TextDecoder().decode(response.body);
  const headers = Object.fromEntries(Object.entries(response.headers)
    .filter(([name]) => !['content-type', 'content-length', 'cache-control'].includes(name.toLowerCase())));
  // A JSON error body under an event-stream header: it already is the error, only the header is wrong.
  if (parseJsonRecord(text.trim())) return { ...response, headers: jsonHeaders(headers) };
  const error = findEventStreamError(text);
  const fallbackMessage = text.trim().slice(0, 1_000) || 'Upstream error';
  const message = typeof error?.message === 'string' && error.message.length > 0 ? error.message : fallbackMessage;
  const body = protocol === 'anthropic-messages'
    ? { type: 'error', error: { type: typeof error?.type === 'string' ? error.type : 'api_error', message } }
    : { error: error ? { ...error, message } : { message, type: 'api_error' } };
  return { ...response, headers: jsonHeaders(headers), body: encodeJson(body) };
}

function findEventStreamError(text: string): Record<string, unknown> | null {
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    const parsed = parseJsonRecord(data);
    if (!parsed) continue;
    if (isRecord(parsed.error)) return parsed.error;
    // A flat error: `{"error":"rate_limited","message":"slow down"}`.
    if (typeof parsed.error === 'string' && typeof parsed.message === 'string') {
      return { message: parsed.message, code: parsed.error };
    }
    if (isRecord(parsed.response) && isRecord(parsed.response.error)) return parsed.response.error;
    if (parsed.type === 'error' && typeof parsed.message === 'string') {
      const { type: _type, sequence_number: _sequence, ...rest } = parsed;
      return rest;
    }
  }
  return null;
}

function parseJsonRecord(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function renderCanonicalResponseStream(
  targetProtocol: ServiceApiProtocol,
  body: Record<string, unknown>,
  canonical: CanonicalLlmResponse,
): Uint8Array {
  if (targetProtocol === 'anthropic-messages') {
    return buildAnthropicMessagesStream(body, canonical.usage);
  }
  if (targetProtocol === 'openai-chat-completions') {
    return buildOpenAIChatStream(canonical);
  }
  return buildOpenAIResponsesStream(body);
}

function buildAnthropicMessagesStream(
  body: Record<string, unknown>,
  usage: ReportedUsage,
): Uint8Array {
  const content = Array.isArray(body.content) ? body.content as Record<string, unknown>[] : [];
  const chunks: string[] = [];
  const pushEvent = (event: string, data: unknown): void => {
    chunks.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  pushEvent('message_start', {
    type: 'message_start',
    message: {
      ...body,
      content: [],
      stop_reason: null,
      usage: { input_tokens: usage.inputTokens, output_tokens: 0 },
    },
  });

  for (const [index, block] of content.entries()) {
    const isText = block.type === 'text';
    pushEvent('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: isText
        ? { type: 'text', text: '' }
        : { type: 'tool_use', id: block.id, name: block.name, input: {} },
    });
    pushEvent('content_block_delta', {
      type: 'content_block_delta',
      index,
      delta: isText
        ? { type: 'text_delta', text: block.text }
        : { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) },
    });
    pushEvent('content_block_stop', { type: 'content_block_stop', index });
  }

  pushEvent('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: body.stop_reason ?? null, stop_sequence: null },
    // As the Messages API does: the reasoning breakdown comes with the final message_delta.
    usage: { output_tokens: usage.outputTokens, ...reasoningUsageFields(usage, 'anthropic-messages') },
  });
  pushEvent('message_stop', { type: 'message_stop' });
  return encodeText(chunks.join(''));
}

function buildOpenAIChatStream(response: CanonicalLlmResponse): Uint8Array {
  const chunks: string[] = [];
  const created = Math.floor(Date.now() / 1000);
  const pushChunk = (
    delta: Record<string, unknown>,
    finishReason?: string | null,
    usage?: Record<string, unknown>,
  ): void => {
    const chunk: Record<string, unknown> = {
      id: response.id,
      object: 'chat.completion.chunk',
      model: response.model,
      created,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) chunk.usage = usage;
    chunks.push(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  pushChunk({ role: 'assistant', content: '' });

  let toolCallIndex = 0;
  for (const item of response.output) {
    if (item.type === 'text') {
      if (item.text.length > 0) pushChunk({ content: item.text });
      continue;
    }
    pushChunk({
      tool_calls: [{
        index: toolCallIndex++,
        id: item.id,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments),
        },
      }],
    });
  }

  pushChunk({}, response.stopReason ?? 'stop', {
    prompt_tokens: response.usage.inputTokens,
    completion_tokens: response.usage.outputTokens,
    total_tokens: response.usage.inputTokens + response.usage.outputTokens,
    ...reasoningUsageFields(response.usage, 'openai-chat-completions'),
  });
  chunks.push('data: [DONE]\n\n');
  return encodeText(chunks.join(''));
}

function buildOpenAIResponsesStream(body: Record<string, unknown>): Uint8Array {
  const sseEvents: string[] = [];
  let sequenceNumber = 0;
  const pushEvent = (event: string, data: Record<string, unknown>): void => {
    sseEvents.push(
      `event: ${event}\ndata: ${JSON.stringify({ type: event, sequence_number: sequenceNumber++, ...data })}\n\n`,
    );
  };

  pushEvent('response.created', {
    response: { ...body, status: 'in_progress', output: [], output_text: '' },
  });

  const output = Array.isArray(body.output) ? body.output as Record<string, unknown>[] : [];
  for (const [outputIndex, outputItem] of output.entries()) {
    if (outputItem.type === 'message') {
      const content = Array.isArray(outputItem.content)
        ? outputItem.content as Record<string, unknown>[]
        : [];
      pushEvent('response.output_item.added', {
        output_index: outputIndex,
        item: { ...outputItem, status: 'in_progress', content: content.map((part) => ({ ...part, text: '' })) },
      });
      for (const [contentIndex, part] of content.entries()) {
        pushEvent('response.content_part.added', {
          output_index: outputIndex,
          item_id: outputItem.id,
          content_index: contentIndex,
          part: { ...part, text: '' },
        });
        pushEvent('response.output_text.delta', {
          output_index: outputIndex,
          item_id: outputItem.id,
          content_index: contentIndex,
          delta: typeof part.text === 'string' ? part.text : '',
          logprobs: [],
        });
        pushEvent('response.output_text.done', {
          output_index: outputIndex,
          item_id: outputItem.id,
          content_index: contentIndex,
          text: typeof part.text === 'string' ? part.text : '',
          logprobs: [],
        });
        pushEvent('response.content_part.done', {
          output_index: outputIndex,
          item_id: outputItem.id,
          content_index: contentIndex,
          part,
        });
      }
      pushEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
      continue;
    }

    if (outputItem.type === 'function_call') {
      const argumentsText = typeof outputItem.arguments === 'string' ? outputItem.arguments : '';
      pushEvent('response.output_item.added', {
        output_index: outputIndex,
        item: { ...outputItem, status: 'in_progress', arguments: '' },
      });
      pushEvent('response.function_call_arguments.delta', {
        output_index: outputIndex,
        item_id: outputItem.id,
        call_id: outputItem.call_id,
        delta: argumentsText,
      });
      pushEvent('response.function_call_arguments.done', {
        output_index: outputIndex,
        item_id: outputItem.id,
        call_id: outputItem.call_id,
        name: outputItem.name,
        arguments: argumentsText,
      });
      pushEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
      continue;
    }

    if (outputItem.type === 'reasoning') {
      pushEvent('response.output_item.added', { output_index: outputIndex, item: { ...outputItem, content: [] } });
      pushEvent('response.output_item.done', { output_index: outputIndex, item: outputItem });
    }
  }

  pushEvent('response.completed', { response: body });
  sseEvents.push('data: [DONE]\n\n');

  return encodeText(sseEvents.join(''));
}

function fallbackResponseId(requestId: string, targetProtocol: ServiceApiProtocol): string {
  if (targetProtocol === 'anthropic-messages') return `msg_${requestId}`;
  if (targetProtocol === 'openai-responses') return `resp_${requestId}`;
  return `chatcmpl-${requestId}`;
}

function extractErrorMessage(parsed: Record<string, unknown>): string {
  const error = parsed.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string' && message.length > 0) return message;
  }
  if (typeof parsed.message === 'string' && parsed.message.length > 0) return parsed.message;
  if (typeof error === 'string' && error.length > 0) return error;
  return 'Upstream error';
}

function normalizeOpenAIError(parsed: Record<string, unknown>): Record<string, unknown> {
  const error = parsed.error;
  if (error && typeof error === 'object' && !Array.isArray(error)) {
    const errorPayload = error as Record<string, unknown>;
    return {
      ...errorPayload,
      message: typeof errorPayload.message === 'string' ? errorPayload.message : extractErrorMessage(parsed),
      type: typeof errorPayload.type === 'string' ? errorPayload.type : 'api_error',
    };
  }

  let type = 'api_error';
  if (typeof error === 'string' && error.length > 0) {
    type = error;
  } else if (typeof parsed.type === 'string' && parsed.type.length > 0) {
    type = parsed.type;
  }

  return {
    ...parsed,
    type,
    message: extractErrorMessage(parsed),
  };
}

function jsonHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'application/json' };
}

function streamHeaders(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
}

import type { SerializedHttpResponse, ServiceApiProtocol } from './types.js';
import {
  normalizeAnthropicMessagesResponseBody,
  normalizeOpenAIChatResponseBody,
  normalizeOpenAIResponsesResponseBody,
  renderCanonicalResponseToAnthropicMessagesBody,
  renderCanonicalResponseToOpenAIChatBody,
  renderCanonicalResponseToOpenAIResponsesBody,
  namespacedToolFor,
  type CanonicalLlmResponse,
  type NamespacedToolNames,
} from './canonical.js';
import { createLeadingThinkMarkupFilter, type ThinkMarkupPiece } from './think-markup.js';
import { encodeJson, encodeText, parseJsonObject, reasoningUsageFields, responsesEndTurn, type ReportedUsage } from './utils.js';

export interface ServiceApiResponseTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  streamRequested?: boolean;
  fallbackModel?: string | null;
  /** A Responses client that keeps reasoning state gets a chat model's reasoning (see `includeReasoning` on transformRequest). */
  includeReasoning?: boolean;
  /** The request's flattened namespace functions (see `namespacedTools` on transformRequest). */
  namespacedTools?: NamespacedToolNames;
  /**
   * A Messages client gets a `thinking` block only when it asked for thoughts (`includeThinking` of
   * `transformRequest`'s result). Without it, thoughts a seller wrote on its own are left out, as they
   * were before. Other client protocols are not affected.
   */
  includeThinking?: boolean;
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

  const normalized = withoutLeadingThinkMarkup(normalize(parsed, {
    id: fallbackResponseId(response.requestId, options.to),
    model: options.fallbackModel ?? 'unknown',
    requestedModel: options.fallbackModel ?? null,
  }), options.fallbackModel ?? null);
  const { reasoning: _reasoning, reasoningModel: _reasoningModel, ...withoutReasoning } = normalized;
  const shown = withNamespacedCalls(
    options.includeReasoning === true ? normalized : withoutReasoning,
    options.to === 'openai-responses' ? options.namespacedTools : undefined,
  );
  const canonical: CanonicalLlmResponse = options.to === 'anthropic-messages' && options.includeThinking !== true
    ? { ...shown, output: shown.output.filter((item) => item.type !== 'reasoning') }
    : shown;
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
 * The answer without think markup a seller leaked at the start of its text (see `think-markup.ts`), read the way
 * a stream reads it: one filter over the answer's items in order, so markup split across text blocks (as a
 * Messages answer can have it) is found too, and held text settles before a tool call. A leading block's text
 * joins the reasoning; text left empty is dropped. A block that never closed is thinking only when the answer
 * was cut off or went on to call a tool: when the turn ended there, it is the answer.
 */
function withoutLeadingThinkMarkup(response: CanonicalLlmResponse, requestedModel: string | null): CanonicalLlmResponse {
  type OutputItem = CanonicalLlmResponse['output'][number];
  type TextItem = Extract<OutputItem, { type: 'text' }>;
  if (!response.output.some((item) => item.type === 'text')) return response;
  const filter = createLeadingThinkMarkupFilter();
  const output: OutputItem[] = [];
  let thoughts = '';
  let phase: TextItem['phase'];
  const place = (pieces: ThinkMarkupPiece[]): void => {
    const text = pieces.filter((piece) => piece.kind === 'text').map((piece) => piece.text).join('');
    thoughts += pieces.filter((piece) => piece.kind === 'reasoning').map((piece) => piece.text).join('');
    if (text.length > 0) output.push({ type: 'text', text, ...(phase ? { phase } : {}) });
  };
  for (const item of response.output) {
    if (item.type === 'text') {
      phase = item.phase;
      place(filter.push(item.text));
      continue;
    }
    if (item.type === 'function_call') place(filter.release());
    output.push(item);
  }
  const toolCalls = response.output.filter((item) => item.type === 'function_call').length;
  place(filter.end(responsesEndTurn(toolCalls, response.stopReason)));

  const unchanged = thoughts.length === 0
    && output.length === response.output.length
    && output.every((item, index) => item === response.output[index]
      || (item.type === 'text' && (response.output[index] as TextItem).text === item.text));
  if (unchanged) return response;
  // The block's thoughts join the answer's thoughts, as both kept forms: the output item (Messages thinking
  // blocks, Chat `reasoning_content`) and the reasoning Responses clients get.
  if (thoughts.length > 0) {
    const index = output.findIndex((other) => other.type === 'reasoning');
    if (index >= 0) {
      const existing = output[index] as Extract<OutputItem, { type: 'reasoning' }>;
      output[index] = { ...existing, text: existing.text + thoughts };
    } else {
      output.unshift({ type: 'reasoning', text: thoughts });
    }
  }
  const reasoning = (response.reasoning ?? '') + thoughts;
  return {
    ...response,
    output,
    ...(reasoning.trim().length > 0
      ? { reasoning, reasoningModel: response.reasoningModel ?? (requestedModel || response.model) }
      : {}),
  };
}

/** A call to a flattened namespace function as the client defined it: the tool's own name and its namespace. */
function withNamespacedCalls(response: CanonicalLlmResponse, namespacedTools: NamespacedToolNames | undefined): CanonicalLlmResponse {
  if (!namespacedTools || Object.keys(namespacedTools).length === 0) return response;
  return {
    ...response,
    output: response.output.map((item) => {
      const origin = item.type === 'function_call' ? namespacedToolFor(namespacedTools, item.name) : undefined;
      return origin ? { ...item, name: origin.name, namespace: origin.namespace } : item;
    }),
  };
}

function transformErrorResponse(
  response: SerializedHttpResponse,
  parsed: Record<string, unknown>,
  options: ServiceApiResponseTransformOptions,
): SerializedHttpResponse {
  if (options.to === 'anthropic-messages') {
    return transformAnthropicErrorResponse(response, parsed, options.streamRequested === true);
  }

  return transformOpenAICompatibleErrorResponse(response, parsed, options);
}

function transformAnthropicErrorResponse(
  response: SerializedHttpResponse,
  parsed: Record<string, unknown>,
  streamRequested: boolean,
): SerializedHttpResponse {
  const body = { type: 'error', error: { type: 'api_error', message: extractErrorMessage(parsed) } };
  if (streamRequested) {
    return {
      ...response,
      headers: streamHeaders(response.headers),
      body: encodeText(`event: error\ndata: ${JSON.stringify(body)}\n\n`),
    };
  }

  return {
    ...response,
    headers: jsonHeaders(response.headers),
    body: encodeJson(body),
  };
}

function transformOpenAICompatibleErrorResponse(
  response: SerializedHttpResponse,
  parsed: Record<string, unknown>,
  options: ServiceApiResponseTransformOptions,
): SerializedHttpResponse {
  const body = { error: normalizeOpenAIError(parsed) };
  if (options.streamRequested) {
    return {
      ...response,
      headers: streamHeaders(response.headers),
      body: encodeText(formatOpenAICompatibleErrorStream(options.to, body)),
    };
  }

  return {
    ...response,
    headers: jsonHeaders(response.headers),
    body: encodeJson(body),
  };
}

function formatOpenAICompatibleErrorStream(
  targetProtocol: ServiceApiProtocol,
  body: Record<string, unknown>,
): string {
  if (targetProtocol === 'openai-chat-completions') {
    return `data: ${JSON.stringify(body)}\n\ndata: [DONE]\n\n`;
  }
  return `event: error\ndata: ${JSON.stringify(body)}\n\n`;
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
    let contentBlock: Record<string, unknown>;
    let delta: Record<string, unknown>;
    if (block.type === 'thinking') {
      contentBlock = { type: 'thinking', thinking: '' };
      delta = { type: 'thinking_delta', thinking: block.thinking };
    } else if (block.type === 'text') {
      contentBlock = { type: 'text', text: '' };
      delta = { type: 'text_delta', text: block.text };
    } else {
      contentBlock = { type: 'tool_use', id: block.id, name: block.name, input: {} };
      delta = { type: 'input_json_delta', partial_json: JSON.stringify(block.input ?? {}) };
    }
    pushEvent('content_block_start', { type: 'content_block_start', index, content_block: contentBlock });
    pushEvent('content_block_delta', { type: 'content_block_delta', index, delta });
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
    if (item.type === 'reasoning') {
      pushChunk({ reasoning_content: item.text });
      continue;
    }
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

  // The answer's ending is the final event's to tell.
  const { incomplete_details: _ending, ...started } = body;
  pushEvent('response.created', {
    response: { ...started, status: 'in_progress', output: [], output_text: '' },
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

  pushEvent(`response.${body.status}`, { response: body });
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

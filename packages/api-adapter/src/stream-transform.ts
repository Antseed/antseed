import type { SerializedHttpResponseChunk, ServiceApiProtocol } from './types.js';
import {
  createChatStreamParser,
  encodeSseEvents,
  extractUsage,
  RESPONSES_FINAL_ANSWER_TOOL,
  makeStreamingStartResponse,
  mapFinishReasonToAnthropicStopReason,
  openAIResponsesFunctionCallId,
  openAIResponsesMessageId,
  parseJsonSafe,
  parseSseBuffer,
  type StreamingResponseAdapter,
  type TokenUsage,
} from './utils.js';

export interface ServiceApiStreamTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
  fallbackModel?: string | null;
}

interface CanonicalStreamToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
}

type CanonicalStreamEvent =
  | { type: 'response_start'; id: string; model: string; usage: TokenUsage }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | {
    type: 'response_done';
    id: string;
    model: string;
    finishReason: string | null;
    endTurn?: boolean;
    usage: TokenUsage;
    toolCalls: CanonicalStreamToolCall[];
  };

type CanonicalStreamNormalizer = (options: StreamTransformInternals) => ProtocolStreamNormalizer;
type CanonicalStreamRenderer = (options: StreamTransformInternals) => ProtocolStreamRenderer;

interface StreamTransformInternals {
  fallbackModel: string | null;
  forceResponsesAgentTools?: boolean;
}

interface ProtocolStreamNormalizer {
  feed(chunk: SerializedHttpResponseChunk): CanonicalStreamEvent[];
}

interface ProtocolStreamRenderer {
  render(events: CanonicalStreamEvent[], chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
}

const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };

const RESPONSES_CONTINUE_TOOL = 'exec_command';

const STREAM_NORMALIZERS: Partial<Record<ServiceApiProtocol, CanonicalStreamNormalizer>> = {
  'anthropic-messages': createAnthropicStreamNormalizer,
  'openai-chat-completions': createChatStreamNormalizer,
  'openai-responses': createResponsesStreamNormalizer,
};

const STREAM_RENDERERS: Partial<Record<ServiceApiProtocol, CanonicalStreamRenderer>> = {
  'anthropic-messages': createAnthropicStreamRenderer,
  'openai-chat-completions': createChatStreamRenderer,
  'openai-responses': createResponsesStreamRenderer,
};

export function createStreamingAdapter(
  options: ServiceApiStreamTransformOptions,
): StreamingResponseAdapter | null {
  if (options.from === options.to) return null;

  const createNormalizer = STREAM_NORMALIZERS[options.from];
  const createRenderer = STREAM_RENDERERS[options.to];
  if (!createNormalizer || !createRenderer) return null;

  const internals = {
    fallbackModel: options.fallbackModel ?? null,
    forceResponsesAgentTools: options.from === 'openai-responses',
  };
  const normalizer = createNormalizer(internals);
  const renderer = createRenderer(internals);

  return {
    adaptStart: makeStreamingStartResponse,
    adaptChunk(chunk) {
      const events = normalizer.feed(chunk);
      return renderer.render(events, chunk);
    },
  };
}

function createChatStreamNormalizer(options: StreamTransformInternals): ProtocolStreamNormalizer {
  const emitted: CanonicalStreamEvent[] = [];
  let responseStarted = false;
  let sawRealToolCall = false;
  let sawFinalMarker = false;
  let textBuffer = '';

  const emitStart = (id: string, model: string, usage: TokenUsage = ZERO_USAGE): void => {
    if (responseStarted) return;
    responseStarted = true;
    emitted.push({
      type: 'response_start',
      id,
      model: model || options.fallbackModel || 'unknown',
      usage,
    });
  };

  const parser = createChatStreamParser({
    onText(delta) {
      emitStart(parser.getId(), parser.getModel());
      textBuffer += delta;
      emitted.push({ type: 'text_delta', delta });
    },
    onToolCallStart(index, id, name) {
      emitStart(parser.getId(), parser.getModel());
      if (name === RESPONSES_FINAL_ANSWER_TOOL) return;
      sawRealToolCall = true;
      sawFinalMarker = false;
      emitted.push({ type: 'tool_call_start', index, id, name });
    },
    onToolCallDelta(index, _id, argumentsDelta) {
      emitted.push({ type: 'tool_call_delta', index, argumentsDelta });
    },
    onFinish(info) {
      emitStart(info.id, info.model, info.usage);
      if (info.toolCalls.some((toolCall) => toolCall.name === RESPONSES_FINAL_ANSWER_TOOL)) {
        sawFinalMarker = true;
      }
      const forceToolCompletion = options.forceResponsesAgentTools && !sawRealToolCall;
      const toolCalls = forceToolCompletion
        ? [...info.toolCalls, {
          index: Math.max(-1, ...info.toolCalls.map((toolCall) => toolCall.index)) + 1,
          id: `final_${info.id || 'response'}`,
          name: sawFinalMarker || /\s+(Done|Complete|Complete\.)$/i.test(textBuffer)
            ? RESPONSES_FINAL_ANSWER_TOOL
            : RESPONSES_CONTINUE_TOOL,
          arguments: '',
        }]
        : info.toolCalls;
      emitted.push({
        type: 'response_done',
        id: info.id,
        model: info.model,
        finishReason: info.finishReason,
        endTurn: !forceToolCompletion,
        usage: info.usage,
        toolCalls,
      });
    },
  }, {
    id: '',
    model: options.fallbackModel ?? 'unknown',
  });

  return {
    feed(chunk) {
      emitted.length = 0;
      parser.feed(chunk.data, chunk.done);
      return [...emitted];
    },
  };
}

function createAnthropicStreamNormalizer(options: StreamTransformInternals): ProtocolStreamNormalizer {
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  let usage: TokenUsage = ZERO_USAGE;
  let finishReason: string | null = null;
  let responseStarted = false;
  const toolBlockIndexes = new Map<number, number>();
  const toolCalls = new Map<number, CanonicalStreamToolCall>();

  const toolIndexForBlock = (blockIndex: number): number => {
    const existing = toolBlockIndexes.get(blockIndex);
    if (existing !== undefined) return existing;
    const next = toolBlockIndexes.size;
    toolBlockIndexes.set(blockIndex, next);
    return next;
  };

  const emitStart = (emitted: CanonicalStreamEvent[]): void => {
    if (responseStarted) return;
    responseStarted = true;
    emitted.push({
      type: 'response_start',
      id: responseId,
      model: responseModel,
      usage,
    });
  };

  return {
    feed(chunk) {
      const emitted: CanonicalStreamEvent[] = [];
      sseBuffer += decoder.decode(chunk.data, { stream: !chunk.done });
      const { events, remainder } = parseSseBuffer(sseBuffer);
      sseBuffer = remainder;

      for (const event of events) {
        if (event.data === '[DONE]') continue;
        const parsed = parseJsonSafe(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const data = parsed as Record<string, unknown>;
        const type = typeof data.type === 'string' ? data.type : event.event;

        if (type === 'message_start') {
          const message = data.message && typeof data.message === 'object'
            ? data.message as Record<string, unknown>
            : {};
          if (typeof message.id === 'string') responseId = message.id;
          if (typeof message.model === 'string') responseModel = message.model;
          usage = extractUsage({ usage: message.usage });
          emitStart(emitted);
          continue;
        }

        if (type === 'content_block_start') {
          const block = data.content_block && typeof data.content_block === 'object'
            ? data.content_block as Record<string, unknown>
            : {};
          if (block.type === 'tool_use') {
            emitStart(emitted);
            const blockIndex = typeof data.index === 'number' ? data.index : 0;
            const index = toolIndexForBlock(blockIndex);
            const id = typeof block.id === 'string' ? block.id : `call_${index + 1}`;
            const name = typeof block.name === 'string' ? block.name : 'tool';
            toolCalls.set(index, { index, id, name, arguments: '' });
            emitted.push({ type: 'tool_call_start', index, id, name });
          }
          continue;
        }

        if (type === 'content_block_delta') {
          const delta = data.delta && typeof data.delta === 'object'
            ? data.delta as Record<string, unknown>
            : {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string') {
            emitStart(emitted);
            emitted.push({ type: 'text_delta', delta: delta.text });
            continue;
          }
          if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
            emitStart(emitted);
            const blockIndex = typeof data.index === 'number' ? data.index : 0;
            const index = toolIndexForBlock(blockIndex);
            const existing = toolCalls.get(index) ?? { index, id: `call_${index + 1}`, name: 'tool', arguments: '' };
            toolCalls.set(index, { ...existing, arguments: existing.arguments + delta.partial_json });
            emitted.push({ type: 'tool_call_delta', index, argumentsDelta: delta.partial_json });
          }
          continue;
        }

        if (type === 'message_delta') {
          const delta = data.delta && typeof data.delta === 'object'
            ? data.delta as Record<string, unknown>
            : {};
          finishReason = anthropicStopReasonToCanonical(delta.stop_reason);
          usage = mergeOutputUsage(usage, extractUsage({ usage: data.usage }));
          continue;
        }

        if (type === 'message_stop') {
          emitStart(emitted);
          emitted.push({
            type: 'response_done',
            id: responseId,
            model: responseModel,
            finishReason: finishReason ?? 'stop',
            usage,
            toolCalls: sortedToolCalls(toolCalls),
          });
        }
      }

      if (chunk.done && emitted.length === 0) {
        return [{
          type: 'response_done',
          id: responseId,
          model: responseModel,
          finishReason: finishReason ?? 'stop',
          usage,
          toolCalls: sortedToolCalls(toolCalls),
        }];
      }

      return emitted;
    },
  };
}

function createResponsesStreamNormalizer(options: StreamTransformInternals): ProtocolStreamNormalizer {
  const decoder = new TextDecoder();
  let sseBuffer = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  let usage: TokenUsage = ZERO_USAGE;
  let responseStarted = false;
  const toolOutputIndexes = new Map<number, number>();
  const toolCalls = new Map<number, CanonicalStreamToolCall>();

  const toolIndexForOutput = (outputIndex: number): number => {
    const existing = toolOutputIndexes.get(outputIndex);
    if (existing !== undefined) return existing;
    const next = toolOutputIndexes.size;
    toolOutputIndexes.set(outputIndex, next);
    return next;
  };

  const emitStart = (emitted: CanonicalStreamEvent[]): void => {
    if (responseStarted) return;
    responseStarted = true;
    emitted.push({
      type: 'response_start',
      id: responseId,
      model: responseModel,
      usage,
    });
  };

  return {
    feed(chunk) {
      const emitted: CanonicalStreamEvent[] = [];
      sseBuffer += decoder.decode(chunk.data, { stream: !chunk.done });
      const { events, remainder } = parseSseBuffer(sseBuffer);
      sseBuffer = remainder;

      for (const event of events) {
        if (event.data === '[DONE]') continue;
        const parsed = parseJsonSafe(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const data = parsed as Record<string, unknown>;
        const type = typeof data.type === 'string' ? data.type : event.event;

        if (type === 'response.created') {
          const response = objectValue(data.response);
          if (typeof response.id === 'string') responseId = response.id;
          if (typeof response.model === 'string') responseModel = response.model;
          usage = extractUsage({ usage: response.usage });
          emitStart(emitted);
          continue;
        }

        if (type === 'response.output_text.delta') {
          emitStart(emitted);
          if (typeof data.delta === 'string') emitted.push({ type: 'text_delta', delta: data.delta });
          continue;
        }

        if (type === 'response.output_item.added') {
          const item = objectValue(data.item);
          if (item.type === 'function_call') {
            emitStart(emitted);
            const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0;
            const index = toolIndexForOutput(outputIndex);
            const id = responseToolCallId(item.call_id ?? item.id, index);
            const name = typeof item.name === 'string' ? item.name : 'tool';
            toolCalls.set(index, { index, id, name, arguments: '' });
            emitted.push({ type: 'tool_call_start', index, id, name });
          }
          continue;
        }

        if (type === 'response.function_call_arguments.delta') {
          emitStart(emitted);
          const outputIndex = typeof data.output_index === 'number' ? data.output_index : 0;
          const index = toolIndexForOutput(outputIndex);
          const argumentsDelta = typeof data.delta === 'string' ? data.delta : '';
          const existing = toolCalls.get(index) ?? { index, id: `call_${index + 1}`, name: 'tool', arguments: '' };
          toolCalls.set(index, { ...existing, arguments: existing.arguments + argumentsDelta });
          if (argumentsDelta.length > 0) emitted.push({ type: 'tool_call_delta', index, argumentsDelta });
          continue;
        }

        if (type === 'response.completed') {
          const response = objectValue(data.response);
          if (typeof response.id === 'string') responseId = response.id;
          if (typeof response.model === 'string') responseModel = response.model;
          usage = mergeUsage(usage, extractUsage({ usage: response.usage }));
          emitCompletedResponseOutput(response.output, toolCalls, toolOutputIndexes);
          emitStart(emitted);
          emitted.push({
            type: 'response_done',
            id: responseId,
            model: responseModel,
            finishReason: openAIResponsesStreamFinishReason(response, toolCalls),
            usage,
            toolCalls: sortedToolCalls(toolCalls),
          });
        }
      }

      return emitted;
    },
  };
}

function createChatStreamRenderer(options: StreamTransformInternals): ProtocolStreamRenderer {
  const encoder = new TextEncoder();
  const createdTimestamp = Math.floor(Date.now() / 1000);
  const fallbackId = `chatcmpl-${createdTimestamp}`;
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';

  const renderChunk = (
    delta: Record<string, unknown>,
    finishReason?: string | null,
    usage?: Record<string, unknown>,
  ): string => {
    const body: Record<string, unknown> = {
      id: responseId || fallbackId,
      object: 'chat.completion.chunk',
      model: responseModel,
      created: createdTimestamp,
      choices: [{ index: 0, delta, finish_reason: finishReason ?? null }],
    };
    if (usage) body.usage = usage;
    return `data: ${JSON.stringify(body)}\n\n`;
  };

  return {
    render(events, chunk) {
      const chunks: string[] = [];

      for (const event of events) {
        if (event.type === 'response_start') {
          if (event.id.length > 0) responseId = event.id;
          if (event.model.length > 0) responseModel = event.model;
          chunks.push(renderChunk({ role: 'assistant', content: '' }));
          continue;
        }

        if (event.type === 'text_delta') {
          chunks.push(renderChunk({ content: event.delta }));
          continue;
        }

        if (event.type === 'tool_call_start') {
          chunks.push(renderChunk({
            tool_calls: [{
              index: event.index,
              id: event.id || `call_${event.index + 1}`,
              type: 'function',
              function: { name: event.name || 'tool', arguments: '' },
            }],
          }));
          continue;
        }

        if (event.type === 'tool_call_delta') {
          chunks.push(renderChunk({
            tool_calls: [{ index: event.index, function: { arguments: event.argumentsDelta } }],
          }));
          continue;
        }

        if (event.type === 'response_done') {
          chunks.push(renderChunk({}, event.finishReason ?? 'stop', openAIChatUsage(event.usage)));
          chunks.push('data: [DONE]\n\n');
        }
      }

      if (chunks.length > 0) {
        return [{ requestId: chunk.requestId, data: encoder.encode(chunks.join('')), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}

function createAnthropicStreamRenderer(options: StreamTransformInternals): ProtocolStreamRenderer {
  let messageStarted = false;
  let textBlockStarted = false;
  let hadTextBlock = false;
  let openToolIndex: number | null = null;
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';

  const toolBlockIndex = (index: number): number => index + (hadTextBlock ? 1 : 0);

  const startMessage = (
    emitted: Array<{ event?: string; data: unknown | string }>,
    event: Extract<CanonicalStreamEvent, { type: 'response_start' }> | null,
  ): void => {
    if (event) {
      if (event.id.length > 0) responseId = event.id;
      if (event.model.length > 0) responseModel = event.model;
    }
    if (messageStarted) return;
    messageStarted = true;
    emitted.push({
      event: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: responseId || fallbackAnthropicId(options.fallbackModel),
          type: 'message',
          role: 'assistant',
          model: responseModel,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: anthropicUsage(event?.usage ?? ZERO_USAGE),
        },
      },
    });
  };

  return {
    render(events, chunk) {
      const emitted: Array<{ event?: string; data: unknown | string }> = [];

      for (const event of events) {
        if (event.type === 'response_start') {
          startMessage(emitted, event);
          continue;
        }

        if (event.type === 'text_delta') {
          startMessage(emitted, null);
          if (openToolIndex !== null) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolBlockIndex(openToolIndex) } });
            openToolIndex = null;
          }
          if (!textBlockStarted) {
            textBlockStarted = true;
            hadTextBlock = true;
            emitted.push({
              event: 'content_block_start',
              data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            });
          }
          emitted.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: event.delta } },
          });
          continue;
        }

        if (event.type === 'tool_call_start') {
          startMessage(emitted, null);
          if (textBlockStarted) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
            textBlockStarted = false;
          }
          if (openToolIndex !== null && openToolIndex !== event.index) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolBlockIndex(openToolIndex) } });
          }
          emitted.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: toolBlockIndex(event.index),
              content_block: {
                type: 'tool_use',
                id: event.id || `toolu_${event.index + 1}`,
                name: event.name || 'tool',
                input: {},
              },
            },
          });
          openToolIndex = event.index;
          continue;
        }

        if (event.type === 'tool_call_delta') {
          startMessage(emitted, null);
          emitted.push({
            event: 'content_block_delta',
            data: {
              type: 'content_block_delta',
              index: toolBlockIndex(event.index),
              delta: { type: 'input_json_delta', partial_json: event.argumentsDelta },
            },
          });
          continue;
        }

        if (event.type === 'response_done') {
          startMessage(emitted, null);
          if (openToolIndex !== null) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolBlockIndex(openToolIndex) } });
            openToolIndex = null;
          }
          if (textBlockStarted) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
            textBlockStarted = false;
          }
          emitted.push({
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: mapFinishReasonToAnthropicStopReason(event.finishReason), stop_sequence: null },
              usage: { output_tokens: event.usage.outputTokens },
            },
          });
          emitted.push({ event: 'message_stop', data: { type: 'message_stop' } });
        }
      }

      if (emitted.length > 0) {
        return [{ requestId: chunk.requestId, data: encodeSseEvents(emitted), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}

function createResponsesStreamRenderer(options: StreamTransformInternals): ProtocolStreamRenderer {
  let sequenceNumber = 0;
  let responseCreated = false;
  let outputStarted = false;
  let outputDone = false;
  let textBuffer = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  const createdAt = Math.floor(Date.now() / 1000);
  const toolCalls = new Map<number, CanonicalStreamToolCall>();

  const pushEvent = (
    emitted: Array<{ event?: string; data: unknown | string }>,
    event: string,
    data: Record<string, unknown>,
  ): void => {
    emitted.push({ event, data: { type: event, sequence_number: sequenceNumber++, ...data } });
  };

  const getResponseId = (): string => responseId || fallbackResponsesId(options.fallbackModel);
  const getMessageId = (): string => openAIResponsesMessageId(getResponseId());
  const getToolOutputIndex = (index: number): number => index + (outputStarted ? 1 : 0);

  const ensureResponseCreated = (
    emitted: Array<{ event?: string; data: unknown | string }>,
    event: Extract<CanonicalStreamEvent, { type: 'response_start' }> | null,
  ): void => {
    if (event) {
      if (event.id.length > 0) responseId = event.id;
      if (event.model.length > 0) responseModel = event.model;
    }
    if (responseCreated) return;
    responseCreated = true;
    pushEvent(emitted, 'response.created', {
      response: {
        id: getResponseId(),
        object: 'response',
        model: responseModel,
        status: 'in_progress',
        created_at: createdAt,
        output: [],
        output_text: '',
        usage: openAIResponsesUsage(event?.usage ?? ZERO_USAGE),
      },
    });
  };

  const ensureTextOutputStarted = (emitted: Array<{ event?: string; data: unknown | string }>): void => {
    ensureResponseCreated(emitted, null);
    if (outputStarted) return;
    outputStarted = true;
    const msgId = getMessageId();
    pushEvent(emitted, 'response.output_item.added', {
      output_index: 0,
      item: {
        type: 'message',
        id: msgId,
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    });
    pushEvent(emitted, 'response.content_part.added', {
      output_index: 0,
      item_id: msgId,
      content_index: 0,
      part: { type: 'output_text', text: '', annotations: [] },
    });
  };

  return {
    render(events, chunk) {
      const emitted: Array<{ event?: string; data: unknown | string }> = [];

      for (const event of events) {
        if (event.type === 'response_start') {
          ensureResponseCreated(emitted, event);
          continue;
        }

        if (event.type === 'text_delta') {
          ensureTextOutputStarted(emitted);
          textBuffer += event.delta;
          pushEvent(emitted, 'response.output_text.delta', {
            output_index: 0,
            item_id: getMessageId(),
            content_index: 0,
            delta: event.delta,
            logprobs: [],
          });
          continue;
        }

        if (event.type === 'tool_call_start') {
          ensureResponseCreated(emitted, null);
          const toolCall = {
            index: event.index,
            id: event.id || `call_${event.index + 1}`,
            name: event.name || 'tool',
            arguments: '',
          };
          toolCalls.set(event.index, toolCall);
          const itemId = openAIResponsesFunctionCallId(toolCall.id);
          pushEvent(emitted, 'response.output_item.added', {
            output_index: getToolOutputIndex(event.index),
            item: {
              type: 'function_call',
              id: itemId,
              call_id: toolCall.id,
              name: toolCall.name,
              arguments: '',
              status: 'in_progress',
            },
          });
          continue;
        }

        if (event.type === 'tool_call_delta') {
          const existing = toolCalls.get(event.index) ?? {
            index: event.index,
            id: `call_${event.index + 1}`,
            name: 'tool',
            arguments: '',
          };
          const toolCall = { ...existing, arguments: existing.arguments + event.argumentsDelta };
          toolCalls.set(event.index, toolCall);
          pushEvent(emitted, 'response.function_call_arguments.delta', {
            output_index: getToolOutputIndex(event.index),
            item_id: openAIResponsesFunctionCallId(toolCall.id),
            call_id: toolCall.id,
            delta: event.argumentsDelta,
          });
          continue;
        }

        if (event.type === 'response_done') {
          ensureResponseCreated(emitted, null);
          const messagePhase = toolCalls.size > 0 ? 'commentary' : undefined;
          if (!outputDone) {
            outputDone = true;
            const msgId = getMessageId();
            if (outputStarted) {
              pushEvent(emitted, 'response.output_text.done', {
                output_index: 0,
                item_id: msgId,
                content_index: 0,
                text: textBuffer,
                logprobs: [],
              });
              pushEvent(emitted, 'response.content_part.done', {
                output_index: 0,
                item_id: msgId,
                content_index: 0,
                part: { type: 'output_text', text: textBuffer, annotations: [] },
              });
              pushEvent(emitted, 'response.output_item.done', {
                output_index: 0,
                item: {
                  type: 'message',
                  id: msgId,
                  role: 'assistant',
                  status: 'completed',
                  content: [{ type: 'output_text', text: textBuffer, annotations: [] }],
                  ...(messagePhase ? { phase: messagePhase } : {}),
                },
              });
            }

            for (const toolCall of sortedToolCalls(toolCalls)) {
              const outputIndex = getToolOutputIndex(toolCall.index);
              const itemId = openAIResponsesFunctionCallId(toolCall.id);
              pushEvent(emitted, 'response.function_call_arguments.done', {
                output_index: outputIndex,
                item_id: itemId,
                call_id: toolCall.id,
                name: toolCall.name,
                arguments: toolCall.arguments,
              });
              pushEvent(emitted, 'response.output_item.done', {
                output_index: outputIndex,
                item: {
                  type: 'function_call',
                  id: itemId,
                  call_id: toolCall.id,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                  status: 'completed',
                },
              });
            }
          }

          pushEvent(emitted, 'response.completed', {
            response: {
              id: getResponseId(),
              object: 'response',
              model: responseModel,
              status: 'completed',
              created_at: createdAt,
              output: [
                ...(outputStarted ? [{
                  type: 'message' as const,
                  id: getMessageId(),
                  role: 'assistant' as const,
                  status: 'completed' as const,
                  content: [{ type: 'output_text' as const, text: textBuffer, annotations: [] }],
                  ...(messagePhase ? { phase: messagePhase } : {}),
                }] : []),
                ...sortedToolCalls(toolCalls).map((toolCall) => ({
                  type: 'function_call' as const,
                  id: openAIResponsesFunctionCallId(toolCall.id),
                  call_id: toolCall.id,
                  name: toolCall.name,
                  arguments: toolCall.arguments,
                  status: 'completed' as const,
                })),
              ],
              output_text: textBuffer,
              ...(event.endTurn !== undefined ? { end_turn: event.endTurn } : {}),
              usage: openAIResponsesUsage(event.usage),
            },
          });
          emitted.push({ data: '[DONE]' });
        }
      }

      if (emitted.length > 0) {
        return [{ requestId: chunk.requestId, data: encodeSseEvents(emitted), done: chunk.done }];
      }
      if (chunk.done) {
        return [{ requestId: chunk.requestId, data: new Uint8Array(0), done: true }];
      }
      return [];
    },
  };
}

function emitCompletedResponseOutput(
  output: unknown,
  toolCalls: Map<number, CanonicalStreamToolCall>,
  toolOutputIndexes: Map<number, number>,
): void {
  const items = Array.isArray(output) ? output : [];
  for (const [outputIndex, rawItem] of items.entries()) {
    if (!rawItem || typeof rawItem !== 'object') continue;
    const item = rawItem as Record<string, unknown>;
    if (item.type !== 'function_call') continue;
    const index = toolIndexForCompletedOutput(outputIndex, toolOutputIndexes);
    const existing = toolCalls.get(index);
    toolCalls.set(index, {
      index,
      id: responseToolCallId(item.call_id ?? item.id, index),
      name: typeof item.name === 'string' ? item.name : existing?.name ?? 'tool',
      arguments: typeof item.arguments === 'string' ? item.arguments : existing?.arguments ?? '',
    });
  }
}

function toolIndexForCompletedOutput(outputIndex: number, toolOutputIndexes: Map<number, number>): number {
  const existing = toolOutputIndexes.get(outputIndex);
  if (existing !== undefined) return existing;
  const next = toolOutputIndexes.size;
  toolOutputIndexes.set(outputIndex, next);
  return next;
}

function openAIResponsesStreamFinishReason(
  response: Record<string, unknown>,
  toolCalls: Map<number, CanonicalStreamToolCall>,
): string | null {
  if (response.status === 'incomplete') {
    const details = objectValue(response.incomplete_details);
    if (details.reason === 'max_output_tokens') return 'length';
    if (details.reason === 'content_filter') return 'content_filter';
    return null;
  }
  return toolCalls.size > 0 ? 'tool_calls' : 'stop';
}

function responseToolCallId(value: unknown, index: number): string {
  const id = typeof value === 'string' && value.length > 0 ? value : `call_${index + 1}`;
  return id.startsWith('fc_') ? id.slice(3) : id;
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function mergeUsage(previous: TokenUsage, next: TokenUsage): TokenUsage {
  return {
    inputTokens: next.inputTokens > 0 ? next.inputTokens : previous.inputTokens,
    outputTokens: next.outputTokens > 0 ? next.outputTokens : previous.outputTokens,
    freshInputTokens: next.freshInputTokens > 0 ? next.freshInputTokens : previous.freshInputTokens,
    cachedInputTokens: next.cachedInputTokens > 0 ? next.cachedInputTokens : previous.cachedInputTokens,
  };
}

function mergeOutputUsage(previous: TokenUsage, next: TokenUsage): TokenUsage {
  return { ...previous, outputTokens: next.outputTokens > 0 ? next.outputTokens : previous.outputTokens };
}

function openAIChatUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
  };
}

function openAIResponsesUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
  };
}

function anthropicUsage(usage: TokenUsage): Record<string, unknown> {
  return {
    input_tokens: usage.freshInputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens > 0 ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
  };
}

function sortedToolCalls(toolCalls: Map<number, CanonicalStreamToolCall>): CanonicalStreamToolCall[] {
  return [...toolCalls.values()].sort((a, b) => a.index - b.index);
}

function anthropicStopReasonToCanonical(stopReason: unknown): string | null {
  if (typeof stopReason !== 'string' || stopReason.length === 0) return null;
  if (stopReason === 'end_turn') return 'stop';
  if (stopReason === 'max_tokens') return 'length';
  if (stopReason === 'tool_use') return 'tool_calls';
  return stopReason;
}

function fallbackAnthropicId(fallbackModel: string | null): string {
  return fallbackModel ? `msg_${fallbackModel}` : 'msg_stream';
}

function fallbackResponsesId(fallbackModel: string | null): string {
  return fallbackModel ? `resp_${fallbackModel}` : 'resp_stream';
}

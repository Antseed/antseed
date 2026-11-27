import { namespacedToolFor, type NamespacedToolNames } from './canonical.js';
import { createLeadingThinkMarkupFilter, type LeadingThinkMarkupFilter, type ThinkMarkupPiece } from './think-markup.js';
import type { SerializedHttpResponseChunk, ServiceApiProtocol } from './types.js';
import {
  createChatStreamParser,
  encodeSseEvents,
  extractReportedUsage,
  openAIResponsesReasoningItem,
  makeStreamingStartResponse,
  mapFinishReasonToAnthropicStopReason,
  openAIResponsesEnding,
  openAIResponsesFunctionCallId,
  openAIResponsesItemStatus,
  openAIResponsesMessageId,
  parseJsonSafe,
  parseSseBuffer,
  type StreamingResponseAdapter,
  reasoningUsageFields,
  responsesEndTurn,
  type ReportedUsage,
} from './utils.js';

export interface ServiceApiStreamTransformOptions {
  from: ServiceApiProtocol;
  to: ServiceApiProtocol;
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

interface CanonicalStreamToolCall {
  index: number;
  id: string;
  name: string;
  arguments: string;
  /** The Responses namespace of the client's tool, whose own name `name` then is. */
  namespace?: string;
}

type CanonicalStreamEvent =
  | { type: 'response_start'; id: string; model: string; usage: ReportedUsage }
  | { type: 'reasoning_delta'; delta: string }
  | { type: 'text_delta'; delta: string }
  | { type: 'tool_call_start'; index: number; id: string; name: string; namespace?: string }
  | { type: 'tool_call_delta'; index: number; argumentsDelta: string }
  | {
    type: 'response_done';
    id: string;
    model: string;
    finishReason: string | null;
    endTurn?: boolean;
    usage: ReportedUsage;
    toolCalls: CanonicalStreamToolCall[];
  };

type CanonicalStreamNormalizer = (options: StreamTransformInternals) => ProtocolStreamNormalizer;
type CanonicalStreamRenderer = (options: StreamTransformInternals) => ProtocolStreamRenderer;

interface StreamTransformInternals {
  fallbackModel: string | null;
  includeReasoning: boolean;
}

interface ProtocolStreamNormalizer {
  feed(chunk: SerializedHttpResponseChunk): CanonicalStreamEvent[];
}

interface ProtocolStreamRenderer {
  render(events: CanonicalStreamEvent[], chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
  /** See `StreamingResponseAdapter.keepAlive`. */
  keepAlive?(): Uint8Array | null;
}

const ZERO_USAGE: ReportedUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };

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
    includeReasoning: options.includeReasoning === true,
  };
  const normalizer = createNormalizer(internals);
  const renderer = createRenderer(internals);
  const thinkMarkup = createLeadingThinkMarkupFilter();
  const namespacedTools = options.to === 'openai-responses' ? options.namespacedTools ?? {} : {};
  const dropsThoughts = options.to === 'anthropic-messages' && options.includeThinking !== true;

  return {
    adaptStart: makeStreamingStartResponse,
    adaptChunk(chunk) {
      const events = withNamespacedCalls(withoutLeadingThinkMarkup(normalizer.feed(chunk), thinkMarkup), namespacedTools);
      return renderer.render(dropsThoughts ? events.filter((event) => event.type !== 'reasoning_delta') : events, chunk);
    },
    keepAlive: () => renderer.keepAlive?.() ?? null,
  };
}

/** A call to a flattened namespace function as the client defined it: the tool's own name and its namespace. */
function withNamespacedCalls(events: CanonicalStreamEvent[], namespacedTools: NamespacedToolNames): CanonicalStreamEvent[] {
  return events.map((event) => {
    const origin = event.type === 'tool_call_start' ? namespacedToolFor(namespacedTools, event.name) : undefined;
    return origin ? { ...event, name: origin.name, namespace: origin.namespace } : event;
  });
}

/**
 * The answer's text events with any think markup a seller leaked at its start taken out: a leading block's
 * text becomes reasoning. Text held back while its start could still be a tag is released before a tool call
 * or the end, whichever comes first, so it keeps its place in the answer.
 */
function withoutLeadingThinkMarkup(events: CanonicalStreamEvent[], filter: LeadingThinkMarkupFilter): CanonicalStreamEvent[] {
  const out: CanonicalStreamEvent[] = [];
  const pushPieces = (pieces: ThinkMarkupPiece[]): void => {
    for (const piece of pieces) {
      out.push(piece.kind === 'text' ? { type: 'text_delta', delta: piece.text } : { type: 'reasoning_delta', delta: piece.text });
    }
  };
  for (const event of events) {
    if (event.type === 'text_delta') {
      pushPieces(filter.push(event.delta));
      continue;
    }
    // Held text goes out before a tool call, where the seller sent it: after the call, a Messages client would
    // get a second block at index 0 and a Responses client the items out of order.
    if (event.type === 'tool_call_start') pushPieces(filter.release());
    if (event.type === 'response_done') pushPieces(filter.end(responsesEndTurn(event.toolCalls.length, event.finishReason)));
    out.push(event);
  }
  return out;
}

function createChatStreamNormalizer(options: StreamTransformInternals): ProtocolStreamNormalizer {
  const emitted: CanonicalStreamEvent[] = [];
  let responseStarted = false;

  const emitStart = (id: string, model: string, usage: ReportedUsage = ZERO_USAGE): void => {
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
      emitted.push({ type: 'text_delta', delta });
    },
    onReasoning(delta) {
      emitStart(parser.getId(), parser.getModel());
      emitted.push({ type: 'reasoning_delta', delta });
    },
    onToolCallStart(index, id, name) {
      emitStart(parser.getId(), parser.getModel());
      emitted.push({ type: 'tool_call_start', index, id, name });
    },
    onToolCallDelta(index, _id, argumentsDelta) {
      emitted.push({ type: 'tool_call_delta', index, argumentsDelta });
    },
    onFinish(info) {
      emitStart(info.id, info.model, info.usage);
      emitted.push({
        type: 'response_done',
        id: info.id,
        model: info.model,
        finishReason: info.finishReason,
        endTurn: responsesEndTurn(info.toolCalls.length, info.finishReason),
        usage: info.usage,
        toolCalls: info.toolCalls,
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
  let usage: ReportedUsage = ZERO_USAGE;
  // Raw Messages usage fields seen so far. message_delta may repeat some fields and omit others,
  // so fields it leaves out keep their message_start values instead of reading as zero.
  let rawUsage: Record<string, unknown> = {};
  let finishReason: string | null = null;
  let responseStarted = false;
  // A relay ends every stream with an empty final chunk, after message_stop has already finished the response.
  let responseDone = false;
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
          rawUsage = usageFields(message.usage);
          usage = extractReportedUsage({ usage: rawUsage }, 'anthropic-messages');
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
          if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
            emitStart(emitted);
            if (delta.thinking.length > 0) emitted.push({ type: 'reasoning_delta', delta: delta.thinking });
            continue;
          }
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
          // Some Anthropic-compatible upstreams report input and cache reads only here, not in message_start.
          const reported = usageFields(data.usage);
          rawUsage = { ...rawUsage, ...reported };
          // The reasoning breakdown belongs to the report that gives the output total: one from an earlier report does not outlive a newer total.
          if ('output_tokens' in reported && !('output_tokens_details' in reported)) delete rawUsage.output_tokens_details;
          usage = extractReportedUsage({ usage: rawUsage }, 'anthropic-messages');
          continue;
        }

        if (type === 'message_stop') {
          if (responseDone) continue;
          responseDone = true;
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

      if (chunk.done && !responseDone && emitted.length === 0) {
        responseDone = true;
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
  let usage: ReportedUsage = ZERO_USAGE;
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
          usage = extractReportedUsage({ usage: response.usage }, 'openai-responses');
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
          usage = mergeUsage(usage, extractReportedUsage({ usage: response.usage }, 'openai-responses'));
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

        if (event.type === 'reasoning_delta') {
          chunks.push(renderChunk({ reasoning_content: event.delta }));
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
  let messageStopped = false;
  let textBlockStarted = false;
  let hadTextBlock = false;
  // Thoughts are the first block of a message, when there are any: a thinking block opens only before
  // any text or tool call, and everything after it is numbered one higher.
  let thinkingBlockState: 'none' | 'open' | 'closed' = 'none';
  let openToolIndex: number | null = null;
  // The open tool block's arguments so far, and the calls that started while
  // they were still incomplete. Some upstreams interleave parallel calls'
  // argument chunks; an Anthropic block can't take deltas once stopped, so a
  // later call waits (start and deltas, in order) until the open one's
  // arguments are whole JSON, then streams. Calls that arrive one after
  // another stream as they come.
  let openToolArguments = '';
  const heldTools = new Map<number, { start: Extract<CanonicalStreamEvent, { type: 'tool_call_start' }>; deltas: string[] }>();
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';

  const thinkingBlocks = (): number => (thinkingBlockState === 'none' ? 0 : 1);
  const textBlockIndex = (): number => thinkingBlocks();
  const toolBlockIndex = (index: number): number => index + thinkingBlocks() + (hadTextBlock ? 1 : 0);

  const closeThinking = (emitted: Array<{ event?: string; data: unknown | string }>): void => {
    if (thinkingBlockState !== 'open') return;
    thinkingBlockState = 'closed';
    emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } });
  };

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

  const isWholeJson = (text: string): boolean => {
    if (text.trim().length === 0) return false;
    try {
      JSON.parse(text);
      return true;
    } catch {
      return false;
    }
  };

  const closeOpenTool = (emitted: Array<{ event?: string; data: unknown | string }>): void => {
    if (openToolIndex === null) return;
    emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: toolBlockIndex(openToolIndex) } });
    openToolIndex = null;
    openToolArguments = '';
  };

  const emitToolDelta = (emitted: Array<{ event?: string; data: unknown | string }>, index: number, partialJson: string): void => {
    emitted.push({
      event: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: toolBlockIndex(index),
        delta: { type: 'input_json_delta', partial_json: partialJson },
      },
    });
  };

  const openTool = (emitted: Array<{ event?: string; data: unknown | string }>, event: Extract<CanonicalStreamEvent, { type: 'tool_call_start' }>): void => {
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
    openToolArguments = '';
  };

  /** Streams held calls in order while the open block is done (`all`: every one, at the end of the response). */
  const releaseHeldTools = (emitted: Array<{ event?: string; data: unknown | string }>, all: boolean): void => {
    while (heldTools.size > 0 && (all || openToolIndex === null || isWholeJson(openToolArguments))) {
      const [index, held] = heldTools.entries().next().value!;
      heldTools.delete(index);
      closeOpenTool(emitted);
      openTool(emitted, held.start);
      for (const delta of held.deltas) {
        emitToolDelta(emitted, index, delta);
        openToolArguments += delta;
      }
    }
  };

  return {
    render(events, chunk) {
      const emitted: Array<{ event?: string; data: unknown | string }> = [];

      for (const event of events) {
        if (event.type === 'response_start') {
          startMessage(emitted, event);
          continue;
        }

        if (event.type === 'reasoning_delta') {
          startMessage(emitted, null);
          // Thoughts that come after the answer began have no place before it: dropped, never reordered.
          if (thinkingBlockState === 'closed' || hadTextBlock || openToolIndex !== null || heldTools.size > 0) continue;
          if (thinkingBlockState === 'none') {
            if (event.delta.trim().length === 0) continue;
            thinkingBlockState = 'open';
            emitted.push({
              event: 'content_block_start',
              data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
            });
          }
          emitted.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: event.delta } },
          });
          continue;
        }

        if (event.type === 'text_delta') {
          startMessage(emitted, null);
          closeThinking(emitted);
          releaseHeldTools(emitted, true);
          closeOpenTool(emitted);
          if (!textBlockStarted) {
            textBlockStarted = true;
            hadTextBlock = true;
            emitted.push({
              event: 'content_block_start',
              data: { type: 'content_block_start', index: textBlockIndex(), content_block: { type: 'text', text: '' } },
            });
          }
          emitted.push({
            event: 'content_block_delta',
            data: { type: 'content_block_delta', index: textBlockIndex(), delta: { type: 'text_delta', text: event.delta } },
          });
          continue;
        }

        if (event.type === 'tool_call_start') {
          startMessage(emitted, null);
          closeThinking(emitted);
          if (textBlockStarted) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textBlockIndex() } });
            textBlockStarted = false;
          }
          if (openToolIndex === event.index || heldTools.has(event.index)) continue;
          if (openToolIndex !== null && (heldTools.size > 0 || !isWholeJson(openToolArguments))) {
            heldTools.set(event.index, { start: event, deltas: [] });
            continue;
          }
          closeOpenTool(emitted);
          openTool(emitted, event);
          continue;
        }

        if (event.type === 'tool_call_delta') {
          startMessage(emitted, null);
          const held = heldTools.get(event.index);
          if (held) {
            held.deltas.push(event.argumentsDelta);
            continue;
          }
          emitToolDelta(emitted, event.index, event.argumentsDelta);
          if (event.index === openToolIndex) {
            openToolArguments += event.argumentsDelta;
            releaseHeldTools(emitted, false);
          }
          continue;
        }

        if (event.type === 'response_done') {
          startMessage(emitted, null);
          closeThinking(emitted);
          releaseHeldTools(emitted, true);
          closeOpenTool(emitted);
          if (textBlockStarted) {
            emitted.push({ event: 'content_block_stop', data: { type: 'content_block_stop', index: textBlockIndex() } });
            textBlockStarted = false;
          }
          emitted.push({
            event: 'message_delta',
            data: {
              type: 'message_delta',
              delta: { stop_reason: mapFinishReasonToAnthropicStopReason(event.finishReason), stop_sequence: null },
              // Cumulative usage, as Anthropic's message_delta allows. Input
              // counts are left out when the upstream reported none, so a
              // client keeps the message_start value instead of a made-up zero.
              // When they are reported, cache reads are written even at 0, so
              // a cache count message_start showed can't outlive the final split.
              usage: reportsInput(event.usage)
                ? { ...anthropicUsage(event.usage), cache_read_input_tokens: event.usage.cachedInputTokens }
                : { output_tokens: event.usage.outputTokens, ...reasoningUsageFields(event.usage, 'anthropic-messages') },
            },
          });
          emitted.push({ event: 'message_stop', data: { type: 'message_stop' } });
          messageStopped = true;
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
    // Anthropic's own keep-alive, which its API sends during a stream and its SDKs skip.
    keepAlive() {
      if (!messageStarted || messageStopped) return null;
      return encodeSseEvents([{ event: 'ping', data: { type: 'ping' } }]);
    },
  };
}

function createResponsesStreamRenderer(options: StreamTransformInternals): ProtocolStreamRenderer {
  let sequenceNumber = 0;
  let responseCreated = false;
  let outputStarted = false;
  let outputDone = false;
  let textBuffer = '';
  // Reasoning the model writes before its answer: the first output item, streamed as it comes
  // (a long think would otherwise leave the client's stream silent) and closed when the answer starts.
  let reasoning: 'none' | 'open' | 'closed' = 'none';
  let reasoningBuffer = '';
  let reasoningResponseId = '';
  let reasoningModel = '';
  let responseId = '';
  let responseModel = options.fallbackModel ?? 'unknown';
  const createdAt = Math.floor(Date.now() / 1000);
  const toolCalls = new Map<number, CanonicalStreamToolCall>();
  // Each output item takes the next output_index when it first appears, whatever the order: reasoning,
  // the message and each tool call. A tool call can start before the text.
  let nextOutputIndex = 0;
  let messageOutputIndex: number | null = null;
  const toolOutputIndexes = new Map<number, number>();
  // The item the answer wrote last, the text or a tool call's index: an answer cut at a limit was cut there.
  let lastWritten: 'text' | number | null = null;

  const pushEvent = (
    emitted: Array<{ event?: string; data: unknown | string }>,
    event: string,
    data: Record<string, unknown>,
  ): void => {
    emitted.push({ event, data: { type: event, sequence_number: sequenceNumber++, ...data } });
  };

  const getResponseId = (): string => responseId || fallbackResponsesId(options.fallbackModel);
  const getMessageId = (): string => openAIResponsesMessageId(getResponseId());
  const getMessageOutputIndex = (): number => (messageOutputIndex ??= nextOutputIndex++);
  const getToolOutputIndex = (index: number): number => {
    const existing = toolOutputIndexes.get(index);
    if (existing !== undefined) return existing;
    const assigned = nextOutputIndex++;
    toolOutputIndexes.set(index, assigned);
    return assigned;
  };
  const getReasoningItem = (): Record<string, unknown> => openAIResponsesReasoningItem(reasoningResponseId, reasoningBuffer, reasoningModel);
  const reasoningPart = (emitted: Array<{ event?: string; data: unknown | string }>, event: string, data: Record<string, unknown>): void => {
    pushEvent(emitted, event, { output_index: 0, item_id: getReasoningItem().id, content_index: 0, ...data });
  };
  const closeReasoning = (emitted: Array<{ event?: string; data: unknown | string }>): void => {
    if (reasoning !== 'open') return;
    reasoning = 'closed';
    reasoningPart(emitted, 'response.reasoning_text.done', { text: reasoningBuffer });
    reasoningPart(emitted, 'response.content_part.done', { part: { type: 'reasoning_text', text: reasoningBuffer } });
    pushEvent(emitted, 'response.output_item.done', { output_index: 0, item: getReasoningItem() });
  };
  // The finished message and tool calls, in output_index order.
  type AnswerItem =
    | { type: 'message'; id: string; role: 'assistant'; status: 'completed' | 'incomplete'; content: Array<{ type: 'output_text'; text: string; annotations: unknown[] }>; phase?: 'commentary' }
    | { type: 'function_call'; outputIndex: number; id: string; call_id: string; name: string; namespace?: string; arguments: string; status: 'completed' | 'incomplete' };
  const answerItems = (ending: ReturnType<typeof openAIResponsesEnding>): Array<{ index: number; item: AnswerItem }> => {
    const phase = toolCalls.size > 0 ? { phase: 'commentary' as const } : {};
    const items: Array<{ index: number; item: AnswerItem }> = [];
    if (outputStarted) {
      items.push({
        index: getMessageOutputIndex(),
        item: { type: 'message', id: getMessageId(), role: 'assistant', status: openAIResponsesItemStatus(ending, lastWritten === 'text'), content: [{ type: 'output_text', text: textBuffer, annotations: [] }], ...phase },
      });
    }
    for (const toolCall of sortedToolCalls(toolCalls)) {
      const outputIndex = getToolOutputIndex(toolCall.index);
      items.push({
        index: outputIndex,
        item: { type: 'function_call', outputIndex, id: openAIResponsesFunctionCallId(toolCall.id), call_id: toolCall.id, name: toolCall.name, ...namespaceOf(toolCall), arguments: toolCall.arguments, status: openAIResponsesItemStatus(ending, lastWritten === toolCall.index, toolCall.arguments) },
      });
    }
    return items.sort((a, b) => a.index - b.index);
  };

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
      output_index: getMessageOutputIndex(),
      item: {
        type: 'message',
        id: msgId,
        role: 'assistant',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    });
    pushEvent(emitted, 'response.content_part.added', {
      output_index: getMessageOutputIndex(),
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
          closeReasoning(emitted);
          ensureTextOutputStarted(emitted);
          textBuffer += event.delta;
          lastWritten = 'text';
          pushEvent(emitted, 'response.output_text.delta', {
            output_index: getMessageOutputIndex(),
            item_id: getMessageId(),
            content_index: 0,
            delta: event.delta,
            logprobs: [],
          });
          continue;
        }

        if (event.type === 'reasoning_delta') {
          if (!options.includeReasoning) continue;
          ensureResponseCreated(emitted, null);
          // Only reasoning before the answer has a place before it in the client's history: once text or
          // a tool call has started, more reasoning is dropped.
          if (reasoning === 'closed' || outputStarted || toolCalls.size > 0) continue;
          if (reasoning === 'none') {
            if (event.delta.trim().length === 0) continue;
            reasoning = 'open';
            // Reasoning opens only before any other item, so it always takes output_index 0.
            nextOutputIndex = 1;
            reasoningResponseId = getResponseId();
            reasoningModel = options.fallbackModel || responseModel;
            pushEvent(emitted, 'response.output_item.added', { output_index: 0, item: { ...getReasoningItem(), content: [] } });
            reasoningPart(emitted, 'response.content_part.added', { part: { type: 'reasoning_text', text: '' } });
          }
          reasoningBuffer += event.delta;
          reasoningPart(emitted, 'response.reasoning_text.delta', { delta: event.delta });
          continue;
        }

        if (event.type === 'tool_call_start') {
          closeReasoning(emitted);
          ensureResponseCreated(emitted, null);
          const toolCall: CanonicalStreamToolCall = {
            index: event.index,
            id: event.id || `call_${event.index + 1}`,
            name: event.name || 'tool',
            arguments: '',
            ...namespaceOf(event),
          };
          toolCalls.set(event.index, toolCall);
          lastWritten = event.index;
          const itemId = openAIResponsesFunctionCallId(toolCall.id);
          pushEvent(emitted, 'response.output_item.added', {
            output_index: getToolOutputIndex(event.index),
            item: {
              type: 'function_call',
              id: itemId,
              call_id: toolCall.id,
              name: toolCall.name,
              ...namespaceOf(toolCall),
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
          lastWritten = event.index;
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
          const ending = openAIResponsesEnding(event.finishReason);
          if (!outputDone) {
            outputDone = true;
            const msgId = getMessageId();
            closeReasoning(emitted);
            for (const { item } of answerItems(ending)) {
              if (item.type === 'message') {
                pushEvent(emitted, 'response.output_text.done', {
                  output_index: getMessageOutputIndex(),
                  item_id: msgId,
                  content_index: 0,
                  text: textBuffer,
                  logprobs: [],
                });
                pushEvent(emitted, 'response.content_part.done', {
                  output_index: getMessageOutputIndex(),
                  item_id: msgId,
                  content_index: 0,
                  part: { type: 'output_text', text: textBuffer, annotations: [] },
                });
                pushEvent(emitted, 'response.output_item.done', { output_index: getMessageOutputIndex(), item });
                continue;
              }
              pushEvent(emitted, 'response.function_call_arguments.done', {
                output_index: item.outputIndex,
                item_id: item.id,
                call_id: item.call_id,
                name: item.name,
                arguments: item.arguments,
              });
              const { outputIndex, ...functionCall } = item;
              pushEvent(emitted, 'response.output_item.done', { output_index: outputIndex, item: functionCall });
            }
          }

          pushEvent(emitted, `response.${ending.status}`, {
            response: {
              id: getResponseId(),
              object: 'response',
              model: responseModel,
              ...ending,
              created_at: createdAt,
              output: [
                ...(reasoning === 'none' ? [] : [getReasoningItem()]),
                ...answerItems(ending).map(({ item }) => {
                  if (item.type === 'message') return item;
                  const { outputIndex: _outputIndex, ...functionCall } = item;
                  return functionCall;
                }),
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
    // `response.in_progress`: a Responses event that carries no output, which the openai SDK, Codex and pi-ai
    // read without changing the answer. A comment line would not do: SSE parsers drop comments, so a client's
    // idle timer never sees them.
    keepAlive() {
      if (!responseCreated || outputDone) return null;
      const emitted: Array<{ event?: string; data: unknown | string }> = [];
      pushEvent(emitted, 'response.in_progress', {
        response: {
          id: getResponseId(),
          object: 'response',
          model: responseModel,
          status: 'in_progress',
          created_at: createdAt,
          output: [],
          output_text: '',
        },
      });
      return encodeSseEvents(emitted);
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

function namespaceOf(call: { namespace?: string }): { namespace?: string } {
  return call.namespace ? { namespace: call.namespace } : {};
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

/** Whether a usage reported any input, fresh or cached (a cache hit can come with a zero prompt count). */
function reportsInput(usage: ReportedUsage): boolean {
  return usage.inputTokens > 0 || usage.cachedInputTokens > 0;
}

/** The usage fields an event actually reported; absent or null fields are left out so they don't overwrite earlier ones. */
function usageFields(value: unknown): Record<string, unknown> {
  return Object.fromEntries(Object.entries(objectValue(value)).filter(([, field]) => field !== undefined && field !== null));
}

function mergeUsage(previous: ReportedUsage, next: ReportedUsage): ReportedUsage {
  // The input counts are one split: take them together from whichever event
  // reported input, so a stale cached or fresh count can't outlive its total.
  const input = reportsInput(next) ? next : previous;
  // The output count and its reasoning breakdown are one report too: a breakdown from an earlier
  // event does not outlive a newer output total that came without one. A report that itemises
  // reasoning is a report on the output even when both are 0.
  const output = next.outputTokens > 0 || next.reasoningTokens !== undefined ? next : previous;
  return {
    inputTokens: input.inputTokens,
    outputTokens: output.outputTokens,
    freshInputTokens: input.freshInputTokens,
    cachedInputTokens: input.cachedInputTokens,
    ...(output.reasoningTokens !== undefined ? { reasoningTokens: output.reasoningTokens } : {}),
  };
}

function openAIChatUsage(usage: ReportedUsage): Record<string, unknown> {
  return {
    prompt_tokens: usage.inputTokens,
    completion_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { prompt_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...reasoningUsageFields(usage, 'openai-chat-completions'),
  };
}

function openAIResponsesUsage(usage: ReportedUsage): Record<string, unknown> {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    total_tokens: usage.inputTokens + usage.outputTokens,
    ...(usage.cachedInputTokens > 0
      ? { input_tokens_details: { cached_tokens: usage.cachedInputTokens } }
      : {}),
    ...reasoningUsageFields(usage, 'openai-responses'),
  };
}

function anthropicUsage(usage: ReportedUsage): Record<string, unknown> {
  return {
    input_tokens: usage.freshInputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cachedInputTokens > 0 ? { cache_read_input_tokens: usage.cachedInputTokens } : {}),
    ...reasoningUsageFields(usage, 'anthropic-messages'),
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

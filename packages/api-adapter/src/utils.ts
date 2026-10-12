import { estimateTokenCount } from 'tokenx';
import type { SerializedHttpResponse, SerializedHttpResponseChunk } from './types.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface StreamingResponseAdapter {
  adaptStart(response: SerializedHttpResponse): SerializedHttpResponse;
  adaptChunk(chunk: SerializedHttpResponseChunk): SerializedHttpResponseChunk[];
}

export interface ParsedSseEvent {
  event: string | null;
  data: string;
}

export function parseJsonObject(body: Uint8Array): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(decoder.decode(body)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value));
}

export function encodeText(text: string): Uint8Array {
  return encoder.encode(text);
}

export function openAIResponsesMessageId(responseId: string): string {
  return `msg_${responseId}_1`;
}

export function openAIResponsesFunctionCallId(callId: string): string {
  return callId.startsWith('fc_') ? callId : `fc_${callId}`;
}

export function parseJsonSafe(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function toNonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.floor(parsed);
}

export interface TokenUsage {
  /** Total logical input tokens, including cached input tokens when reported. */
  inputTokens: number;
  outputTokens: number;
  /** Fresh (non-cached) input tokens. Always independent of cachedInputTokens. */
  freshInputTokens: number;
  /** Cached input tokens (prompt cache hits). Independent count, never overlaps freshInputTokens. */
  cachedInputTokens: number;
}

export const RESPONSES_FINAL_ANSWER_TOOL = 'final_answer';

/** Plain API-shape facts parsed from image generation requests. */
export interface ImageRequestFacts {
  model?: string;
  size?: string;
  quality?: string;
  resolution?: string;
  requestedImages?: number;
  /** Estimated token count of the text prompt only — input images never contribute. */
  promptTokens?: number;
}

/** Plain API-shape usage facts parsed from provider responses. */
export interface ProviderResponseFacts {
  tokenUsage: TokenUsage;
  outputImages?: number;
}

export function extractUsage(parsed: Record<string, unknown>): TokenUsage {
  // Direct shape: { usage: {...} } (OpenAI Chat, Anthropic Messages non-streaming)
  // Nested shapes:
  //   - { response: { usage: {...} } } — OpenAI Responses SSE `response.completed`
  //     events from the Codex backend bury usage under `response`.
  //   - { message: { usage: {...} } } — Anthropic Messages streaming
  //     `message_start` event nests usage under `message`. This is where the
  //     full input + cache_read_input_tokens + cache_creation_input_tokens
  //     values live; without this unwrap, every cached Anthropic stream was
  //     metered at only the small "fresh" tail count from `message_delta`,
  //     making on-chain MetadataRecorded.inputTokens look absurdly low.
  let usage: Record<string, unknown> = {};
  if (parsed.usage && typeof parsed.usage === 'object') {
    usage = parsed.usage as Record<string, unknown>;
  } else if (parsed.response && typeof parsed.response === 'object') {
    const inner = parsed.response as Record<string, unknown>;
    if (inner.usage && typeof inner.usage === 'object') {
      usage = inner.usage as Record<string, unknown>;
    }
  } else if (parsed.message && typeof parsed.message === 'object') {
    const inner = parsed.message as Record<string, unknown>;
    if (inner.usage && typeof inner.usage === 'object') {
      usage = inner.usage as Record<string, unknown>;
    }
  }

  const hasPromptTokens = usage.prompt_tokens !== undefined && usage.prompt_tokens !== null;
  const baseInput = toNonNegativeInt(usage.prompt_tokens ?? usage.input_tokens);
  const cacheCreationInputTokens = toNonNegativeInt(usage.cache_creation_input_tokens);
  const outputTokens = toNonNegativeInt(usage.completion_tokens ?? usage.output_tokens);

  // Cache hits arrive in two competing shapes:
  //   - Subset shape (OpenAI Chat/Responses): cached_tokens is a subset of the
  //     total input count, found under prompt_tokens_details or
  //     input_tokens_details. fresh = total - cached.
  //   - Separate shape (Anthropic): cache_read_input_tokens is reported
  //     alongside input_tokens, where input_tokens is already fresh-only.
  //     fresh = input_tokens; total logical input = fresh + cached.
  // Some providers (e.g. Venice) emit BOTH fields for the same cache hit.
  // Discriminate by the input field, not the cache field: prompt_tokens or
  // input_tokens_details.cached_tokens always implies subset semantics.
  const promptDetails = usage.prompt_tokens_details && typeof usage.prompt_tokens_details === 'object'
    ? (usage.prompt_tokens_details as Record<string, unknown>)
    : {};
  const inputDetails = usage.input_tokens_details && typeof usage.input_tokens_details === 'object'
    ? (usage.input_tokens_details as Record<string, unknown>)
    : {};
  const subsetCached = toNonNegativeInt(promptDetails.cached_tokens ?? inputDetails.cached_tokens);
  const separateCached = toNonNegativeInt(usage.cache_read_input_tokens ?? usage.prompt_cache_hit_tokens);

  const isSubsetShape = hasPromptTokens || inputDetails.cached_tokens !== undefined;
  const cachedInputTokens = Math.max(subsetCached, separateCached);
  const rawInput = isSubsetShape ? baseInput : baseInput + cacheCreationInputTokens;
  const freshInputTokens = isSubsetShape
    ? Math.max(0, rawInput - cachedInputTokens)
    : rawInput;
  const inputTokens = isSubsetShape
    ? rawInput
    : rawInput + cachedInputTokens;

  return { inputTokens, outputTokens, freshInputTokens, cachedInputTokens };
}

export function extractProviderResponseFacts(parsed: Record<string, unknown>): ProviderResponseFacts {
  const tokenUsage = extractUsage(parsed);
  const data = Array.isArray(parsed.data) ? parsed.data : undefined;
  const outputImages = data?.filter(isDeliveredImageOutput).length;

  return {
    tokenUsage,
    ...(outputImages !== undefined ? { outputImages } : {}),
  };
}

export function extractImageRequestFacts(input: {
  path?: string;
  method?: string;
  body?: Record<string, unknown>;
}): ImageRequestFacts {
  const body = input.body ?? {};
  const facts: ImageRequestFacts = {};
  const normalizedPath = input.path?.split('?')[0];
  const isOpenAiImageEndpoint = normalizedPath === '/v1/images/generations'
    || normalizedPath === '/v1/images/edits';

  setStringAttr(facts, 'model', body.model ?? body.service);
  for (const key of ['size', 'quality', 'resolution'] as const) {
    setStringAttr(facts, key, body[key] ?? body[toCamelCase(key)]);
  }
  if (isOpenAiImageEndpoint) {
    facts.size ??= 'auto';
    facts.quality ??= 'auto';
  }
  // OpenAI image generation/edits default to one output image when `n` is omitted.
  const looksLikeOpenAiImageGeneration = isOpenAiImageEndpoint
    || hasImageOutputAttributes(facts);
  const requestedImages = toOptionalPositiveInt(body.n) ?? (looksLikeOpenAiImageGeneration ? 1 : undefined);

  if (requestedImages !== undefined) {
    facts.requestedImages = requestedImages;
  }
  if (typeof body.prompt === 'string' && body.prompt.length > 0) {
    facts.promptTokens = Math.max(1, estimateTokenCount(body.prompt));
  }
  return facts;
}

/** Text fields larger than this are dropped — billing fields are all short. */
const MAX_MULTIPART_TEXT_FIELD_BYTES = 4096;

/**
 * Extract the text (non-file) fields from a multipart/form-data body, e.g. the
 * model/prompt/n/size fields of an OpenAI `/v1/images/edits` request. File
 * parts (any part with a filename) are skipped, so image payloads are never
 * decoded. Returns null when the content type is not multipart or the boundary
 * is missing/malformed.
 */
export function parseMultipartFormFields(
  body: Uint8Array,
  contentType: string | undefined,
): Record<string, string> | null {
  if (!contentType) return null;
  const boundaryMatch = /^multipart\/form-data\s*;.*?boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType.trim());
  const boundary = (boundaryMatch?.[1] ?? boundaryMatch?.[2] ?? '').trim();
  if (!boundary) return null;

  // latin1 keeps a 1:1 byte-to-char mapping so offsets stay byte-accurate
  // even through binary file parts; text field values are re-decoded as UTF-8.
  const text = new TextDecoder('latin1').decode(body);
  const delimiter = `--${boundary}`;
  const fields: Record<string, string> = {};
  let index = text.indexOf(delimiter);
  while (index !== -1) {
    index += delimiter.length;
    if (text.startsWith('--', index)) break;
    const headerEnd = text.indexOf('\r\n\r\n', index);
    if (headerEnd === -1) break;
    const next = text.indexOf(`\r\n${delimiter}`, headerEnd + 4);
    if (next === -1) break;
    const headerBlock = text.slice(index, headerEnd);
    const dispositionParams = /content-disposition:\s*form-data\s*;([^\r\n]*)/i.exec(headerBlock)?.[1];
    if (dispositionParams !== undefined && !/filename\s*=/i.test(dispositionParams)) {
      const name = /name="([^"]*)"/.exec(dispositionParams)?.[1];
      const value = text.slice(headerEnd + 4, next);
      if (name && !(name in fields) && value.length <= MAX_MULTIPART_TEXT_FIELD_BYTES) {
        fields[name] = decoder.decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
      }
    }
    index = next + 2;
  }
  return fields;
}

/**
 * Parse the billing-relevant fields of a request body: JSON objects verbatim,
 * multipart/form-data reduced to its text fields. Returns null for anything
 * else (unparseable JSON, binary, unknown content types).
 */
export function extractRequestBodyFields(
  headers: Record<string, string>,
  body: Uint8Array,
): Record<string, unknown> | null {
  const contentType = Object.entries(headers)
    .find(([key]) => key.toLowerCase() === 'content-type')?.[1];
  if (contentType && /^multipart\/form-data/i.test(contentType.trim())) {
    return parseMultipartFormFields(body, contentType);
  }
  return parseJsonObject(body);
}

function toOptionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function setStringAttr(target: ImageRequestFacts, key: keyof Omit<ImageRequestFacts, 'requestedImages' | 'promptTokens'>, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) {
    target[key] = value.trim();
  }
}

function toCamelCase(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function hasImageOutputAttributes(attrs: ImageRequestFacts): boolean {
  return attrs.size !== undefined
    || attrs.quality !== undefined
    || attrs.resolution !== undefined;
}

function isDeliveredImageOutput(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return isNonEmptyString(item.b64_json) || isNonEmptyString(item.url);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function toStringContentBlock(block: Record<string, unknown>): string {
  if ((block.type === 'text' || block.type === 'input_text') && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'output_text' && typeof block.text === 'string') {
    return block.text;
  }
  if (block.type === 'refusal' && typeof block.refusal === 'string') {
    return block.refusal;
  }
  if (block.type === 'tool_result') {
    return toStringContent(block.content);
  }
  return '';
}

export function toStringContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
      .map(toStringContentBlock)
      .filter((s) => s.length > 0)
      .join('\n');
  }
  if (typeof value === 'object') {
    return toStringContentBlock(value as Record<string, unknown>);
  }
  return String(value);
}

export function mapFinishReasonToAnthropicStopReason(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value === 'stop') return 'end_turn';
  if (value === 'length') return 'max_tokens';
  if (value === 'tool_calls' || value === 'function_call') return 'tool_use';
  return value;
}

export function parseSseBuffer(buffer: string): { events: ParsedSseEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const blocks = normalized.split('\n\n');
  const remainder = blocks.pop() ?? '';
  const events: ParsedSseEvent[] = [];

  for (const block of blocks) {
    const lines = block.split('\n');
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith('event: ')) {
        event = line.slice('event: '.length);
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice('data: '.length));
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, remainder };
}

export function encodeSseEvents(events: Array<{ event?: string; data: unknown | string }>): Uint8Array {
  const chunks: string[] = [];
  for (const item of events) {
    if (item.event) {
      chunks.push(`event: ${item.event}\n`);
    }
    const data = typeof item.data === 'string' ? item.data : JSON.stringify(item.data);
    chunks.push(`data: ${data}\n\n`);
  }
  return encoder.encode(chunks.join(''));
}

export function makeStreamingStartResponse(response: SerializedHttpResponse): SerializedHttpResponse {
  return {
    ...response,
    headers: { ...response.headers, 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: new Uint8Array(0),
  };
}

// ---------------------------------------------------------------------------
// Shared OpenAI Chat Completions parsing
// ---------------------------------------------------------------------------

export interface ParsedChatResponse {
  id: string;
  model: string;
  textContent: string;
  toolCalls: Array<{ id: string; name: string; arguments: string }>;
  finishReason: string | null;
  inputTokens: number;
  outputTokens: number;
}

export function parseChatCompletionResponse(
  parsed: Record<string, unknown>,
  fallbacks: { id: string; model: string },
): ParsedChatResponse {
  const id = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : fallbacks.id;
  const model = typeof parsed.model === 'string' && parsed.model.length > 0 ? parsed.model : fallbacks.model;

  const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
  const firstChoice = choices[0] && typeof choices[0] === 'object'
    ? (choices[0] as Record<string, unknown>) : null;
  const message = firstChoice?.message && typeof firstChoice.message === 'object'
    ? (firstChoice.message as Record<string, unknown>) : null;

  const textContent = toStringContent(message?.content);

  const toolCalls: ParsedChatResponse['toolCalls'] = [];
  const rawToolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
  for (const [i, raw] of rawToolCalls.entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const tc = raw as Record<string, unknown>;
    const fn = tc.function && typeof tc.function === 'object'
      ? (tc.function as Record<string, unknown>) : {};
    toolCalls.push({
      id: typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `call_${i + 1}`,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: typeof fn.arguments === 'string' ? fn.arguments : '{}',
    });
  }

  const finishReason = typeof firstChoice?.finish_reason === 'string' ? firstChoice.finish_reason : null;
  const { inputTokens, outputTokens } = extractUsage(parsed);

  return { id, model, textContent, toolCalls, finishReason, inputTokens, outputTokens };
}

// ---------------------------------------------------------------------------
// Shared OpenAI Chat Completions stream parser
// ---------------------------------------------------------------------------

export interface ChatStreamFinishInfo {
  id: string;
  model: string;
  usage: TokenUsage;
  finishReason: string | null;
  toolCalls: Array<{ index: number; id: string; name: string; arguments: string }>;
}

export interface ChatStreamCallbacks {
  onText(delta: string): void;
  onToolCallStart(index: number, id: string, name: string): void;
  onToolCallDelta(index: number, id: string, argumentsDelta: string): void;
  onFinish(info: ChatStreamFinishInfo): void;
}

export interface ChatStreamParser {
  getId(): string;
  getModel(): string;
  feed(data: Uint8Array, done: boolean): void;
}

export function createChatStreamParser(
  callbacks: ChatStreamCallbacks,
  fallbacks?: { id?: string; model?: string },
): ChatStreamParser {
  let rawBuffer = '';
  const streamDecoder = new TextDecoder();
  let id = fallbacks?.id ?? '';
  let model = fallbacks?.model ?? 'unknown';
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
  let finishReason: string | null = null;
  const toolCalls = new Map<number, { id: string; name: string; arguments: string }>();

  return {
    getId: () => id,
    getModel: () => model,
    feed(data, done) {
      if (data.length > 0) {
        rawBuffer += streamDecoder.decode(data, { stream: !done });
      }
      const { events, remainder } = parseSseBuffer(rawBuffer);
      rawBuffer = remainder;

      for (const event of events) {
        if (event.data === '[DONE]') continue;
        const parsed = parseJsonSafe(event.data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const p = parsed as Record<string, unknown>;

        if (typeof p.id === 'string' && p.id.length > 0) id = p.id;
        if (typeof p.model === 'string' && p.model.length > 0) model = p.model;

        if (p.usage && typeof p.usage === 'object') {
          usage = extractUsage(p);
        }

        const choices = Array.isArray(p.choices) ? p.choices : [];
        const firstChoice = choices[0] && typeof choices[0] === 'object'
          ? choices[0] as Record<string, unknown> : null;
        const delta = firstChoice?.delta && typeof firstChoice.delta === 'object'
          ? firstChoice.delta as Record<string, unknown> : null;

        if (typeof firstChoice?.finish_reason === 'string' && firstChoice.finish_reason.length > 0) {
          finishReason = firstChoice.finish_reason;
        }

        const textDelta = typeof delta?.content === 'string' ? delta.content : '';
        if (textDelta.length > 0) {
          callbacks.onText(textDelta);
        }

        const deltaToolCalls = Array.isArray(delta?.tool_calls) ? delta.tool_calls : [];
        for (const tcRaw of deltaToolCalls) {
          if (!tcRaw || typeof tcRaw !== 'object') continue;
          const tc = tcRaw as Record<string, unknown>;
          const rawIdx = typeof tc.index === 'number' ? tc.index : 0;
          const idx = Number.isFinite(rawIdx) ? Math.max(0, Math.floor(rawIdx)) : 0;
          const fn = tc.function && typeof tc.function === 'object'
            ? tc.function as Record<string, unknown> : {};
          const existing = toolCalls.get(idx);
          const tcId = typeof tc.id === 'string' && tc.id.length > 0
            ? tc.id : (existing?.id ?? '');
          const tcName = typeof fn.name === 'string' && fn.name.length > 0
            ? fn.name : (existing?.name ?? '');
          const argsDelta = typeof fn.arguments === 'string' ? fn.arguments : '';

          if (!existing) {
            callbacks.onToolCallStart(idx, tcId, tcName);
          }

          toolCalls.set(idx, {
            id: tcId,
            name: tcName,
            arguments: (existing?.arguments ?? '') + argsDelta,
          });

          if (argsDelta.length > 0) {
            callbacks.onToolCallDelta(idx, tcId, argsDelta);
          }
        }
      }

      if (done) {
        const sorted = [...toolCalls.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([index, tc]) => ({ index, ...tc }));
        callbacks.onFinish({ id, model, usage, finishReason, toolCalls: sorted });
      }
    },
  };
}

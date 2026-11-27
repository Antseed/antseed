import { isEncryptedReasoning, parseJsonObject } from '@antseed/api-adapter';
import { estimateTokensFromBytes, estimateTokensFromBytesSampled } from './pricing.js';
import { parseResponseUsage, readStreamEvents, type ResponseUsage } from './response-usage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The fields of a chat message or delta that hold what the model wrote. */
const GENERATED_FIELDS = new Set(['content', 'text', 'reasoning_content', 'reasoning', 'refusal', 'tool_calls', 'function_call', 'function', 'name', 'arguments']);
/**
 * Content part types that hold an attachment: OpenAI Chat (`image_url`, `input_audio`, `file`),
 * OpenAI Responses (`input_image`, `input_file`) and Anthropic Messages (`image`, `document`).
 * Their encoded size says nothing about their tokens: a base64 screenshot is hundreds of KB.
 */
const ATTACHMENT_PARTS = new Set(['image_url', 'input_audio', 'file', 'input_image', 'input_file', 'image', 'document']);
/** What one attachment counts as: roughly what chat upstreams bill for an image. */
const ATTACHMENT_TOKENS = 1_290;
/** The reasoning fields of a chat message or delta, which some upstreams fill with an encrypted item instead of text. */
const REASONING_FIELDS = new Set(['reasoning_content', 'reasoning']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a parsed stream event reports a failure: an error event in the OpenAI chat, OpenAI Responses or Anthropic Messages stream. */
export function isStreamError(event: Record<string, unknown>): boolean {
  return event.type === 'error' || event.type === 'response.failed' || isRecord(event.error);
}

/** Every string the model wrote in a chat message or delta: content, reasoning, tool names and arguments. */
function generatedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(generatedText).join('');
  if (!isRecord(value)) return '';
  return Object.entries(value)
    // An encrypted reasoning item's size says nothing about the tokens the model reasoned.
    .filter(([key, field]) => GENERATED_FIELDS.has(key) && !(REASONING_FIELDS.has(key) && isEncryptedReasoning(value, field)))
    .map(([, field]) => generatedText(field))
    .join('');
}

/** The text of the choices in a chat response or stream event; null when it has no choices. */
function choicesText(event: Record<string, unknown>): string | null {
  if (!Array.isArray(event.choices)) return null;
  return event.choices.map((choice: Record<string, unknown> | null) => generatedText(choice?.delta ?? choice?.message ?? choice?.text)).join('');
}

/** The text of a chat answer, sent whole or as an event stream; null for any other body or a stream that failed. */
function chatAnswerText(body: Uint8Array): string | null {
  const whole = parseJsonObject(body);
  if (whole) return choicesText(whole);
  let answer: string | null = null;
  for (const event of readStreamEvents(decoder.decode(body))) {
    if (event.names.includes('error')) return null;
    for (const value of event.values) {
      if (!isRecord(value)) continue;
      if (isStreamError(value)) return null;
      const text = choicesText(value);
      if (text !== null) answer = (answer ?? '') + text;
    }
  }
  return answer;
}

/** The tokens of a chat request: its text, with a flat allowance in place of each attachment. */
export function estimatePromptTokens(requestBody: Uint8Array): number {
  return promptTokens(parseJsonObject(requestBody), requestBody);
}

function promptTokens(request: Record<string, unknown> | null, requestBody: Uint8Array): number {
  if (!request) return estimateTokensFromBytes(requestBody);
  let attachments = 0;
  const text = JSON.stringify(request, function (key: string, value: unknown) {
    if (key === '' || !isRecord(value) || typeof value.type !== 'string' || !ATTACHMENT_PARTS.has(value.type)) return value;
    attachments += 1;
    return { type: value.type };
  });
  return estimateTokensFromBytes(encoder.encode(text)) + attachments * ATTACHMENT_TOKENS;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Whether a content part is an image in the form its API defines: OpenAI Chat `image_url` (a URL
 * string or `{ url }`), OpenAI Responses `input_image` (`image_url` or `file_id`) or Anthropic
 * Messages `image` (a `source` of a known type). An upstream resizes an image before it reads it, so
 * its tokens stay near the flat allowance however large its encoding is.
 */
function isImagePart(part: Record<string, unknown>): boolean {
  switch (part.type) {
    case 'image_url': return isString(part.image_url) || (isRecord(part.image_url) && isString(part.image_url.url));
    case 'input_image': return isString(part.image_url) || isString(part.file_id);
    case 'image': return isRecord(part.source) && ['base64', 'url', 'file'].includes(part.source.type as string);
    default: return false;
  }
}

/**
 * The image parts of a chat request, found only where the APIs put content: the parts of each message
 * (`messages[].content[]`, Responses `input[].content[]`), of an Anthropic tool result inside them,
 * and of a Responses tool output (`input[].output[]`). An object shaped like an image anywhere else
 * (a tool's input or schema, a default, application data) is text the model reads, and counts as text.
 */
function imageParts(request: Record<string, unknown>): Set<object> {
  const found = new Set<object>();
  const addFrom = (parts: unknown, nested: boolean): void => {
    if (!Array.isArray(parts)) return;
    for (const part of parts) {
      if (!isRecord(part)) continue;
      if (isImagePart(part)) found.add(part);
      else if (nested && part.type === 'tool_result') addFrom(part.content, false);
    }
  };
  for (const list of [request.messages, request.input]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isRecord(item)) continue;
      addFrom(item.content, true);
      if (item.type === 'function_call_output') addFrom(item.output, false);
    }
  }
  return found;
}

/**
 * The prompt tokens of a chat request, for checks before it goes upstream (buyer limits, whether a
 * reserve covers it): `request` is `body` parsed. Each image part counts the flat allowance, never its
 * base64, which is megabytes of body but not of tokens. Everything else, audio, files, documents and
 * anything image-shaped outside a content part, counts by its bytes as before, so the estimate never
 * drops below what those can cost. The text is sampled (`estimateTokensFromBytesSampled`), and a body
 * without image parts is not written again.
 */
export function estimatePromptTokensForChecks(request: Record<string, unknown>, body: Uint8Array): number {
  const images = imageParts(request);
  if (images.size === 0) return estimateTokensFromBytesSampled(body);
  const text = JSON.stringify(request, (_key: string, value: unknown) => (
    isRecord(value) && images.has(value) ? { type: value.type } : value
  ));
  return estimateTokensFromBytesSampled(encoder.encode(text)) + images.size * ATTACHMENT_TOKENS;
}

const positive = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);

/**
 * The most output a chat request allows over all its answers, or 0 for no limit: the larger of its
 * two limit fields (an upstream may read only one) for each of its `n` answers.
 */
function chatOutputLimit(request: Record<string, unknown> | null): number {
  return Math.max(positive(request?.max_completion_tokens), positive(request?.max_tokens)) * Math.max(1, positive(request?.n));
}

/**
 * What a chat answer that arrived with no usage figure is billed as: the
 * prompt's estimated tokens plus the tokens of the text the model wrote,
 * without the JSON or SSE framing around it, and never more output than the
 * request allowed (the upstream stops there). Counted in full, not sampled:
 * the buyer writes the prompt, and a sample reads only windows it can see. Null for a body that is not a
 * chat answer, and for a stream that reports it failed: neither is billed.
 */
export function estimateChatAnswerUsage(requestBody: Uint8Array, responseBody: Uint8Array): ResponseUsage | null {
  const text = chatAnswerText(responseBody);
  if (text === null) return null;
  const request = parseJsonObject(requestBody);
  const inputTokens = promptTokens(request, requestBody);
  const outputTokens = estimateTokensFromBytes(encoder.encode(text));
  const maxOutputTokens = chatOutputLimit(request);
  return {
    inputTokens,
    freshInputTokens: inputTokens,
    cachedInputTokens: 0,
    outputTokens: maxOutputTokens > 0 ? Math.min(outputTokens, maxOutputTokens) : outputTokens,
  };
}

/**
 * The usage a paid answer is billed by. The buyer and the seller both call it
 * on the same request and answer bytes, so they agree on the charge: the
 * answer's own usage figure, or, for a delivered chat answer whose figure is
 * missing or all zeros, the estimate (`estimated` is then true).
 */
export function usageForBilling(
  requestBody: Uint8Array,
  response: { statusCode: number; body: Uint8Array },
): { usage: ResponseUsage; estimated: boolean } {
  const usage = parseResponseUsage(response.body);
  if (response.statusCode >= 400 || usage.inputTokens + usage.outputTokens > 0) return { usage, estimated: false };
  const estimate = estimateChatAnswerUsage(requestBody, response.body);
  return estimate ? { usage: estimate, estimated: true } : { usage, estimated: false };
}

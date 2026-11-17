import { parseJsonObject } from '@antseed/api-adapter';
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
    .filter(([key]) => GENERATED_FIELDS.has(key))
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

/** A parsed chat request written without its attachments' contents, and how many attachments it had. */
function withoutAttachments(request: Record<string, unknown>): { text: Uint8Array; attachments: number } {
  let attachments = 0;
  const text = JSON.stringify(request, function (key: string, value: unknown) {
    if (key === '' || !isRecord(value) || typeof value.type !== 'string' || !ATTACHMENT_PARTS.has(value.type)) return value;
    attachments += 1;
    return { type: value.type };
  });
  return { text: encoder.encode(text), attachments };
}

/** The tokens of a chat request: its text, with a flat allowance in place of each attachment. */
export function estimatePromptTokens(requestBody: Uint8Array): number {
  const request = parseJsonObject(requestBody);
  if (!request) return estimateTokensFromBytes(requestBody);
  const { text, attachments } = withoutAttachments(request);
  return estimateTokensFromBytes(text) + attachments * ATTACHMENT_TOKENS;
}

/**
 * `estimatePromptTokens` for pre-request checks on a request body already parsed: the text is
 * estimated from samples (`estimateTokensFromBytesSampled`), so a large conversation costs bounded CPU.
 * Attachments count their flat allowance, never their encoded bytes: a chat with a few base64
 * screenshots is megabytes of body but only thousands of tokens upstream.
 */
export function estimateParsedPromptTokensSampled(request: Record<string, unknown>): number {
  const { text, attachments } = withoutAttachments(request);
  return estimateTokensFromBytesSampled(text) + attachments * ATTACHMENT_TOKENS;
}

/**
 * What a chat answer that arrived with no usage figure is billed as: the
 * prompt's estimated tokens plus the tokens of the text the model wrote,
 * without the JSON or SSE framing around it. Counted in full, not sampled:
 * the buyer writes the prompt, and a sample reads only windows it can see. Null for a body that is not a
 * chat answer, and for a stream that reports it failed: neither is billed.
 */
export function estimateChatAnswerUsage(requestBody: Uint8Array, responseBody: Uint8Array): ResponseUsage | null {
  const text = chatAnswerText(responseBody);
  if (text === null) return null;
  const inputTokens = estimatePromptTokens(requestBody);
  return {
    inputTokens,
    freshInputTokens: inputTokens,
    cachedInputTokens: 0,
    outputTokens: estimateTokensFromBytes(encoder.encode(text)),
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

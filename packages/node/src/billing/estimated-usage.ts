import { parseJsonObject } from '@antseed/api-adapter';
import { estimateTokensFromBytesSampled } from '../payments/pricing.js';
import type { ResponseUsage } from '../utils/response-usage.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The fields of a chat message or delta that hold what the model wrote. */
const GENERATED_FIELDS = new Set(['content', 'text', 'reasoning_content', 'reasoning', 'refusal', 'tool_calls', 'function_call', 'function', 'name', 'arguments']);
/** Content parts that hold an attachment, in the field their `type` names. Their encoded size says nothing about their tokens. */
const ATTACHMENT_PARTS = new Set(['image_url', 'input_audio', 'file']);
/** What one attachment counts as: roughly what chat upstreams bill for an image. */
const ATTACHMENT_TOKENS = 1_290;

/** Every string the model wrote in a chat message or delta: content, reasoning, tool names and arguments. */
function generatedText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(generatedText).join('');
  if (!value || typeof value !== 'object') return '';
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

/** The text of a chat answer, sent whole or as an event stream; null for any other body. */
function chatAnswerText(body: Uint8Array): string | null {
  const whole = parseJsonObject(body);
  if (whole) return choicesText(whole);
  let answer: string | null = null;
  for (const line of decoder.decode(body).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    try {
      const text = choicesText(JSON.parse(trimmed.slice(5)) as Record<string, unknown>);
      if (text !== null) answer = (answer ?? '') + text;
    } catch { /* skip non-JSON lines, such as [DONE] */ }
  }
  return answer;
}

/** The tokens of a chat request: its text, with a flat allowance in place of each attachment. */
function estimatePromptTokens(requestBody: Uint8Array): number {
  const request = parseJsonObject(requestBody);
  if (!request) return estimateTokensFromBytesSampled(requestBody);
  let attachments = 0;
  const text = JSON.stringify(request, function (this: Record<string, unknown>, key: string, value: unknown) {
    if (!ATTACHMENT_PARTS.has(key) || this.type !== key) return value;
    attachments += 1;
    return undefined;
  });
  return estimateTokensFromBytesSampled(encoder.encode(text)) + attachments * ATTACHMENT_TOKENS;
}

/**
 * What a chat answer that arrived with no usage figure is billed as: the
 * prompt's estimated tokens plus the tokens of the text the model wrote,
 * without the JSON or SSE framing around it. Null for a body that is not a
 * chat answer, which has nothing to estimate.
 */
export function estimateChatAnswerUsage(requestBody: Uint8Array, responseBody: Uint8Array): ResponseUsage | null {
  const text = chatAnswerText(responseBody);
  if (text === null) return null;
  const inputTokens = estimatePromptTokens(requestBody);
  return {
    inputTokens,
    freshInputTokens: inputTokens,
    cachedInputTokens: 0,
    outputTokens: estimateTokensFromBytesSampled(encoder.encode(text)),
  };
}

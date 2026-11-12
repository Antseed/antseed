import { parseJsonObject, extractUsage, type TokenUsage } from '@antseed/api-adapter';

export type { TokenUsage };
export type ResponseUsage = TokenUsage;

/**
 * Parse actual token usage from an LLM provider response body.
 * Handles both JSON and SSE (streaming) responses. Returns zeros
 * if usage data is not found.
 */
export function parseResponseUsage(body: Uint8Array): ResponseUsage {
  const parsed = parseJsonObject(body);
  if (parsed) {
    return extractUsage(parsed);
  }
  const total: ResponseUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
  for (const event of readStreamEvents(new TextDecoder().decode(body))) {
    for (const value of event.values) {
      const usage = extractUsage(value as Record<string, unknown>);
      if (usage.inputTokens > 0) total.inputTokens = Math.max(total.inputTokens, usage.inputTokens);
      if (usage.outputTokens > 0) total.outputTokens = Math.max(total.outputTokens, usage.outputTokens);
      if (usage.freshInputTokens > 0) total.freshInputTokens = Math.max(total.freshInputTokens, usage.freshInputTokens);
      if (usage.cachedInputTokens > 0) total.cachedInputTokens = Math.max(total.cachedInputTokens, usage.cachedInputTokens);
    }
  }
  return total;
}

/** One event of a server-sent event stream: the names its `event:` lines give and the JSON values its data carries. */
export interface StreamEvent {
  names: string[];
  values: unknown[];
}

const NOT_JSON = Symbol('not JSON');

function parseJson(payload: string): unknown {
  try {
    return JSON.parse(payload) as unknown;
  } catch {
    return NOT_JSON;
  }
}

/**
 * The events of a server-sent event stream, read the same way by the buyer
 * and the seller. The data lines of one event are joined with "\n" into one
 * payload, as the SSE spec says. Lines that do not join into JSON are read one
 * by one: a stream written with no blank lines between its events. Data that
 * is not JSON, such as `[DONE]`, is left out.
 */
export function readStreamEvents(text: string): StreamEvent[] {
  const events: StreamEvent[] = [];
  let names: string[] = [];
  let dataLines: string[] = [];
  const endEvent = (): void => {
    if (names.length > 0 || dataLines.length > 0) {
      const joined = dataLines.length > 1 ? parseJson(dataLines.join('\n')) : NOT_JSON;
      const values = joined === NOT_JSON ? dataLines.map(parseJson).filter((value) => value !== NOT_JSON) : [joined];
      events.push({ names, values });
    }
    names = [];
    dataLines = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      endEvent();
      continue;
    }
    if (trimmed.startsWith('event:')) names.push(trimmed.slice(6).trim());
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload && payload !== '[DONE]') dataLines.push(payload);
  }
  endEvent();
  return events;
}

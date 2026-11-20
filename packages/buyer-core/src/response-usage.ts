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
  return streamUsage(readStreamEvents(new TextDecoder().decode(body)));
}

/** The token usage of a stream's events: the largest figure any event reports, field by field. */
export function streamUsage(events: Iterable<StreamEvent>): ResponseUsage {
  const total: ResponseUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
  for (const event of events) {
    for (const value of event.values) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
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
  /** Every data line joined with "\n": the one payload a standard client reads, whether or not it is JSON. */
  data: string;
  /** A blank line closed the event. A standard client drops an event the stream ended inside. */
  closed: boolean;
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
export function* readStreamEvents(text: string): Generator<StreamEvent> {
  let names: string[] = [];
  let dataLines: string[] = [];
  let allDataLines: string[] = [];
  const takeEvent = (closed: boolean): StreamEvent | null => {
    const joined = dataLines.length > 1 ? parseJson(dataLines.join('\n')) : NOT_JSON;
    const event = names.length > 0 || dataLines.length > 0
      ? { names, values: joined === NOT_JSON ? dataLines.map(parseJson).filter((value) => value !== NOT_JSON) : [joined], data: allDataLines.join('\n'), closed }
      : null;
    names = [];
    dataLines = [];
    allDataLines = [];
    return event;
  };
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const trimmed = line.trim();
    // What follows the last line break is where the stream ended, not a blank line that closes an event.
    if (trimmed === '' && index === lines.length - 1) break;
    if (trimmed === '') {
      const event = takeEvent(true);
      if (event) yield event;
      continue;
    }
    if (trimmed.startsWith('event:')) names.push(trimmed.slice(6).trim());
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    allDataLines.push(payload);
    if (payload && payload !== '[DONE]') dataLines.push(payload);
  }
  const last = takeEvent(false);
  if (last) yield last;
}

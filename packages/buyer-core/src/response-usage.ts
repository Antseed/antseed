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
  const text = new TextDecoder().decode(body);
  const total: ResponseUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };
  /** Adds one payload's usage to the total; false when the payload is not JSON. */
  const read = (payload: string): boolean => {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      return false;
    }
    const usage = extractUsage(event);
    if (usage.inputTokens > 0) total.inputTokens = Math.max(total.inputTokens, usage.inputTokens);
    if (usage.outputTokens > 0) total.outputTokens = Math.max(total.outputTokens, usage.outputTokens);
    if (usage.freshInputTokens > 0) total.freshInputTokens = Math.max(total.freshInputTokens, usage.freshInputTokens);
    if (usage.cachedInputTokens > 0) total.cachedInputTokens = Math.max(total.cachedInputTokens, usage.cachedInputTokens);
    return true;
  };
  /** The data lines of the event being read; a blank line ends an event. */
  let dataLines: string[] = [];
  const endEvent = (): void => {
    // The SSE spec joins the data lines of one event with "\n" into one payload.
    // Lines that do not join into JSON are read one by one: a stream written with no blank lines between its events.
    const joined = dataLines.length > 1 && read(dataLines.join('\n'));
    if (!joined) dataLines.forEach((payload) => read(payload));
    dataLines = [];
  };
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      endEvent();
      continue;
    }
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (payload && payload !== '[DONE]') dataLines.push(payload);
  }
  endEvent();
  return total;
}

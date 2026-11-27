import { createStreamingAdapter } from '../src/stream-transform.js';
import type { ServiceApiProtocol } from '../src/types.js';
import { parseSseBuffer } from '../src/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One event of a translated stream: its SSE name and its JSON data. */
export interface TranslatedEvent {
  event: string | null;
  data: Record<string, any>;
}

/**
 * A chat seller's stream of `frames`, then `[DONE]`, translated for a `to` client as the buyer translates it
 * (the requested model is `example-model`), as the client's events.
 */
export function translateChatStream(to: ServiceApiProtocol, frames: string[], includeReasoning = true): TranslatedEvent[] {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to, fallbackModel: 'example-model', includeReasoning })!;
  let sse = '';
  for (const f of frames) for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(f), done: false })) sse += decoder.decode(out.data);
  for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode('data: [DONE]\n\n'), done: true })) sse += decoder.decode(out.data);
  return parseSseBuffer(sse).events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Record<string, any> }));
}

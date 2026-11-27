import { describe, expect, it } from 'vitest';
import { createStreamingAdapter } from '../src/stream-transform.js';
import type { ServiceApiProtocol } from '../src/types.js';
import { parseSseBuffer, type StreamingResponseAdapter } from '../src/utils.js';

// While a seller is silent (some write a whole tool call's arguments in one chunk at the end), the translated
// stream asks for a keep-alive event: one the client's protocol defines, so its stream reader counts it as
// activity, and that changes nothing in the answer.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-k', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const adapterFor = (to: ServiceApiProtocol): StreamingResponseAdapter =>
  createStreamingAdapter({ from: 'openai-chat-completions', to, fallbackModel: 'example-model', includeReasoning: true })!;

const feed = (adapter: StreamingResponseAdapter, data: string, done = false): string =>
  adapter.adaptChunk({ requestId: 'r', data: encoder.encode(data), done }).map((out) => decoder.decode(out.data)).join('');

const keepAlive = (adapter: StreamingResponseAdapter): string | null => {
  const bytes = adapter.keepAlive?.() ?? null;
  return bytes === null ? null : decoder.decode(bytes);
};

const events = (sse: string): Array<{ event: string | null; data: Json }> =>
  parseSseBuffer(sse).events.filter((e) => e.data !== '[DONE]').map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));

/** A stream where the seller goes silent after the text, then sends a whole tool call at once. */
function silentToolCallStream(to: ServiceApiProtocol, silences: number): { sse: string; keepAlives: string[]; before: string | null; after: string | null } {
  const adapter = adapterFor(to);
  const before = keepAlive(adapter);
  let sse = feed(adapter, frame({ role: 'assistant', content: 'Writing the file.' }));
  const keepAlives: string[] = [];
  for (let i = 0; i < silences; i++) {
    const bytes = keepAlive(adapter);
    if (bytes !== null) keepAlives.push(bytes);
    sse += bytes ?? '';
  }
  sse += feed(adapter, frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt","text":"hello"}' } }] }));
  sse += feed(adapter, frame({}, 'tool_calls'));
  sse += feed(adapter, 'data: [DONE]\n\n', true);
  return { sse, keepAlives, before, after: keepAlive(adapter) };
}

describe('a keep-alive in a translated Responses stream', () => {
  it('is a response.in_progress event for the same response, numbered in sequence with the rest', () => {
    const { sse, keepAlives } = silentToolCallStream('openai-responses', 3);
    expect(keepAlives).toHaveLength(3);

    const all = events(sse);
    const created = all.find((e) => e.event === 'response.created')!.data.response;
    const inProgress = all.filter((e) => e.event === 'response.in_progress');
    expect(inProgress).toHaveLength(3);
    for (const { data } of inProgress) {
      expect(data.type).toBe('response.in_progress');
      expect(data.response).toMatchObject({ id: created.id, object: 'response', model: created.model, status: 'in_progress' });
    }
    expect(all.map((e) => e.data.sequence_number)).toEqual(all.map((_, i) => i));
  });

  it('leaves the answer as it is without keep-alives', () => {
    const plain = silentToolCallStream('openai-responses', 0).sse;
    const kept = silentToolCallStream('openai-responses', 2).sse;
    // Two adapters made a moment apart can straddle a second: the clock is not what is compared.
    const withoutClock = (sse: string) => sse.replace(/"created_at":\d+/g, '"created_at":0');
    const strip = (sse: string) => events(withoutClock(sse))
      .filter((e) => e.event !== 'response.in_progress')
      .map(({ event, data: { sequence_number: _n, ...data } }) => ({ event, data }));
    expect(strip(kept)).toEqual(strip(plain));
    const completed = events(kept).find((e) => e.event === 'response.completed')!.data.response;
    expect(completed.output.map((item: Json) => item.type)).toEqual(['message', 'function_call']);
  });

  it('is not sent before the response started, nor after it ended', () => {
    const { before, after } = silentToolCallStream('openai-responses', 1);
    expect(before).toBeNull();
    expect(after).toBeNull();
  });
});

describe('a keep-alive in a translated Messages stream', () => {
  it('is Anthropic\'s ping event, between message_start and message_stop only', () => {
    const { sse, keepAlives, before, after } = silentToolCallStream('anthropic-messages', 2);
    expect(before).toBeNull();
    expect(after).toBeNull();
    expect(keepAlives).toEqual(['event: ping\ndata: {"type":"ping"}\n\n', 'event: ping\ndata: {"type":"ping"}\n\n']);
    const names = events(sse).map((e) => e.event);
    expect(names.indexOf('ping')).toBeGreaterThan(names.indexOf('message_start'));
    expect(names.lastIndexOf('ping')).toBeLessThan(names.indexOf('message_stop'));
  });
});

describe('a keep-alive in a translated Chat Completions stream', () => {
  it('is never sent: Chat Completions defines no keep-alive event', () => {
    const adapter = createStreamingAdapter({ from: 'anthropic-messages', to: 'openai-chat-completions' })!;
    feed(adapter, `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'm', usage: { input_tokens: 1, output_tokens: 0 } } })}\n\n`);
    expect(keepAlive(adapter)).toBeNull();
  });
});

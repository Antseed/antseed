import { describe, expect, it } from 'vitest';
import { createStreamingAdapter } from '../src/stream-transform.js';
import { createChatStreamParser, parseSseBuffer } from '../src/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const ARGS_A = '{"path":"src/a.ts","edits":[{"oldText":"foo","newText":"bar"}]}';
const ARGS_B = '{"path":"src/b.ts","edits":[{"oldText":"baz","newText":"qux"}]}';

function chatChunk(toolCalls: unknown[], finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finishReason }],
  })}\n\n`;
}

const call = (id: string | undefined, args: string, index?: number): Record<string, unknown> => ({
  ...(index !== undefined ? { index } : {}),
  ...(id ? { id, type: 'function' } : {}),
  function: { ...(id ? { name: 'edit' } : {}), arguments: args },
});

/** Streams OpenAI chat frames to Anthropic SSE and returns each tool_use block's accumulated input, as a client parses it. */
function anthropicToolInputs(frames: string[]): Array<{ id: string; input: unknown }> {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'anthropic-messages' })!;
  let sse = '';
  for (const frame of frames) {
    for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(frame), done: false })) sse += decoder.decode(out.data);
  }
  for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode('data: [DONE]\n\n'), done: true })) sse += decoder.decode(out.data);

  const blocks = new Map<number, { id: string; json: string; stopped?: boolean }>();
  const results: Array<{ id: string; input: unknown }> = [];
  for (const event of parseSseBuffer(sse).events) {
    if (!event.data || event.data === '[DONE]') continue;
    const data = JSON.parse(event.data);
    if (data.type === 'content_block_start' && data.content_block.type === 'tool_use') {
      if (blocks.has(data.index)) throw new Error(`block ${data.index} started twice`);
      blocks.set(data.index, { id: data.content_block.id, json: '' });
    } else if (data.type === 'content_block_delta' && data.delta.type === 'input_json_delta') {
      const block = blocks.get(data.index);
      if (!block || block.stopped) throw new Error(`input_json_delta for block ${data.index} after it stopped`);
      block.json += data.delta.partial_json;
    } else if (data.type === 'content_block_stop' && blocks.has(data.index)) {
      const block = blocks.get(data.index)!;
      block.stopped = true;
      results.push({ id: block.id, input: JSON.parse(block.json) });
    }
  }
  return results;
}

const EXPECTED = [
  { id: 'call_a', input: JSON.parse(ARGS_A) },
  { id: 'call_b', input: JSON.parse(ARGS_B) },
];

describe('chat stream parallel tool calls', () => {
  it('keeps parallel calls apart when the upstream reuses index 0 with new ids', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A, 0)]),
      chatChunk([call('call_b', ARGS_B, 0)], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('keeps parallel calls apart when the upstream sends no index', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A)]),
      chatChunk([call('call_b', ARGS_B)], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('keeps parallel calls apart when both arrive in one delta under index 0', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A, 0), call('call_b', ARGS_B, 0)], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('still joins argument chunks that carry no id onto their call', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A.slice(0, 20), 0)]),
      chatChunk([call(undefined, ARGS_A.slice(20), 0)]),
      chatChunk([call('call_b', ARGS_B.slice(0, 10), 1)]),
      chatChunk([call(undefined, ARGS_B.slice(10), 1)], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('joins index-less argument chunks onto the latest call', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A.slice(0, 20))]),
      chatChunk([call(undefined, ARGS_A.slice(20))]),
      chatChunk([call('call_b', ARGS_B.slice(0, 10))]),
      chatChunk([call(undefined, ARGS_B.slice(10))], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('resumes a call whose id returns after another call under the same index', () => {
    const finished: Array<{ index: number; id: string; arguments: string }> = [];
    const starts: string[] = [];
    const parser = createChatStreamParser({
      onText: () => undefined,
      onToolCallStart: (_index, id) => { starts.push(id); },
      onToolCallDelta: () => undefined,
      onFinish: (info) => { finished.push(...info.toolCalls); },
    });
    const frames = [
      chatChunk([call('call_a', ARGS_A.slice(0, 20), 0)]),
      chatChunk([call('call_b', ARGS_B.slice(0, 10), 0)]),
      chatChunk([{ index: 0, id: 'call_a', function: { arguments: ARGS_A.slice(20) } }]),
      chatChunk([{ index: 0, id: 'call_b', function: { arguments: ARGS_B.slice(10) } }], 'tool_calls'),
    ];
    for (const frame of frames) parser.feed(encoder.encode(frame), false);
    parser.feed(encoder.encode('data: [DONE]\n\n'), true);

    expect(starts).toEqual(['call_a', 'call_b']);
    expect(finished.map(({ id, arguments: args }) => ({ id, input: JSON.parse(args) }))).toEqual(EXPECTED);
  });

  it('keeps interleaved calls whole when converting to Anthropic Messages', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A.slice(0, 20), 0)]),
      chatChunk([call('call_b', ARGS_B.slice(0, 10), 0)]),
      chatChunk([{ index: 0, id: 'call_a', function: { arguments: ARGS_A.slice(20) } }]),
      chatChunk([{ index: 0, id: 'call_b', function: { arguments: ARGS_B.slice(10) } }], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('keeps calls interleaved under distinct indexes whole when converting to Anthropic Messages', () => {
    expect(anthropicToolInputs([
      chatChunk([call('call_a', ARGS_A.slice(0, 20), 0)]),
      chatChunk([call('call_b', ARGS_B.slice(0, 10), 1)]),
      chatChunk([call(undefined, ARGS_A.slice(20), 0)]),
      chatChunk([call(undefined, ARGS_B.slice(10), 1)], 'tool_calls'),
    ])).toEqual(EXPECTED);
  });

  it('streams calls that arrive one after another without holding any back', () => {
    const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'anthropic-messages' })!;
    const first = decoder.decode(adapter.adaptChunk({ requestId: 'r', data: encoder.encode(chatChunk([call('call_a', ARGS_A, 0)])), done: false })[0]!.data);
    const second = decoder.decode(adapter.adaptChunk({ requestId: 'r', data: encoder.encode(chatChunk([call('call_b', ARGS_B, 1)])), done: false })[0]!.data);
    expect(first).toContain('"partial_json"');
    // The second call starts at once: the first one's arguments are whole, so its block stops first.
    expect(second.indexOf('content_block_stop')).toBeLessThan(second.indexOf('"id":"call_b"'));
    expect(second).toContain(JSON.stringify(ARGS_B).slice(1, -1));
  });
});

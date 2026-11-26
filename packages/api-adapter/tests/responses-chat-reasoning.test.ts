import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/request-transform.js';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import { parseSseBuffer } from '../src/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const frame = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-r', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

function streamEvents(frames: string[]): Array<{ event: string | null; data: Record<string, unknown> }> {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-responses' })!;
  let sse = '';
  for (const f of frames) for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(f), done: false })) sse += decoder.decode(out.data);
  for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode('data: [DONE]\n\n'), done: true })) sse += decoder.decode(out.data);
  return parseSseBuffer(sse).events
    .filter((e) => e.data && e.data !== '[DONE]')
    .map((e) => ({ event: e.event ?? null, data: JSON.parse(e.data) as Record<string, unknown> }));
}

const completedResponse = (events: ReturnType<typeof streamEvents>): Record<string, unknown> =>
  events.find((e) => e.event === 'response.completed')!.data.response as Record<string, unknown>;

const itemEvents = (events: ReturnType<typeof streamEvents>, name: string): Array<{ index: number; type: string }> =>
  events.filter((e) => e.event === name).map((e) => ({
    index: e.data.output_index as number,
    type: (e.data.item as Record<string, unknown>).type as string,
  }));

const REASONING_ITEM = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Think about the disk.' }] };

describe('chat reasoning in a translated Responses stream', () => {
  const toolTurn = [
    frame({ role: 'assistant', reasoning_content: 'The user wants ' }),
    frame({ reasoning_content: 'the disk usage.' }),
    frame({ content: 'Checking.' }),
    frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"cmd":"df"}' } }] }),
    frame({}, 'tool_calls'),
    `data: ${JSON.stringify({ id: 'chatcmpl-r', model: 'example-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } })}\n\n`,
  ];

  it('opens a reasoning item first and closes it before the message and calls', () => {
    const events = streamEvents(toolTurn);

    expect(itemEvents(events, 'response.output_item.added')).toEqual([
      { index: 0, type: 'reasoning' }, { index: 1, type: 'message' }, { index: 2, type: 'function_call' },
    ]);
    expect(itemEvents(events, 'response.output_item.done')).toEqual([
      { index: 0, type: 'reasoning' }, { index: 1, type: 'message' }, { index: 2, type: 'function_call' },
    ]);
    expect(events.filter((e) => e.event === 'response.output_text.delta').every((e) => e.data.output_index === 1)).toBe(true);
    const done = events.find((e) => e.event === 'response.output_item.done')!.data.item as Record<string, unknown>;
    expect(done).toMatchObject({ type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'The user wants the disk usage.' }] });
  });

  it('lists the reasoning first in the completed response and passes reasoning tokens through', () => {
    const response = completedResponse(streamEvents(toolTurn));

    expect((response.output as Array<{ type: string }>).map((item) => item.type)).toEqual(['reasoning', 'message', 'function_call']);
    expect((response.usage as Record<string, unknown>).output_tokens_details).toEqual({ reasoning_tokens: 20 });
    expect(response.end_turn).toBe(false);
  });

  it('reads `reasoning` when a seller names it so, and reads a delta that carries both names once', () => {
    const response = completedResponse(streamEvents([
      frame({ reasoning: 'Short ' }),
      frame({ reasoning: 'thought.', reasoning_content: 'thought.' }),
      frame({ content: 'Done.' }),
      frame({}, 'stop'),
    ]));

    expect((response.output as Array<Record<string, unknown>>)[0]).toMatchObject({ content: [{ type: 'reasoning_text', text: 'Short thought.' }] });
  });

  it('adds no reasoning item to an answer without reasoning', () => {
    const events = streamEvents([frame({ content: 'Done.' }), frame({}, 'stop')]);

    expect(itemEvents(events, 'response.output_item.added')).toEqual([{ index: 0, type: 'message' }]);
  });

  it('drops reasoning that starts after the answer, which has no place before it', () => {
    const response = completedResponse(streamEvents([frame({ content: 'Done.' }), frame({ reasoning_content: 'late' }), frame({}, 'stop')]));

    expect((response.output as Array<{ type: string }>).map((item) => item.type)).toEqual(['message']);
  });
});

describe('chat reasoning in a translated buffered Responses answer', () => {
  const chatBody = {
    id: 'chatcmpl-b',
    model: 'example-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done.', reasoning_content: 'All checked.' } }],
    usage: { prompt_tokens: 10, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 4 } },
  };
  const adapt = (streamRequested: boolean) => transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(chatBody)) },
    { from: 'openai-chat-completions', to: 'openai-responses', streamRequested },
  )!;

  it('puts the reasoning item before the message', () => {
    const body = JSON.parse(decoder.decode(adapt(false).body)) as Record<string, unknown>;

    expect(body.output).toEqual([
      { type: 'reasoning', id: 'rs_chatcmpl-b_0', summary: [], content: [{ type: 'reasoning_text', text: 'All checked.' }] },
      expect.objectContaining({ type: 'message' }),
    ]);
    expect((body.usage as Record<string, unknown>).output_tokens_details).toEqual({ reasoning_tokens: 4 });
  });

  it('streams the reasoning item to a client that asked for a stream', () => {
    const events = parseSseBuffer(decoder.decode(adapt(true).body)).events
      .filter((e) => e.data && e.data !== '[DONE]')
      .map((e) => ({ event: e.event ?? null, data: JSON.parse(e.data) as Record<string, unknown> }));

    expect(itemEvents(events, 'response.output_item.done')).toEqual([{ index: 0, type: 'reasoning' }, { index: 1, type: 'message' }]);
  });
});

function toChatMessages(input: unknown[], to: 'openai-chat-completions' | 'anthropic-messages' = 'openai-chat-completions'): Record<string, unknown> {
  const result = transformRequest({
    requestId: 'r',
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({ model: 'example-model', input, tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }] })),
  }, { from: 'openai-responses', to });
  return JSON.parse(decoder.decode(result!.request.body)) as Record<string, unknown>;
}

const user = { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'How full is the disk?' }] };
const preamble = { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'Checking.' }] };
const fnCall = { type: 'function_call', call_id: 'call_1', name: 'run', arguments: '{"cmd":"df"}' };
const fnOutput = { type: 'function_call_output', call_id: 'call_1', output: '40%' };
const answer = { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It is 40% full.' }] };

describe('Responses reasoning sent back to a chat model', () => {
  it('rides on the assistant message that carries the turn text and its calls', () => {
    const messages = toChatMessages([user, REASONING_ITEM, preamble, fnCall, fnOutput]).messages as Array<Record<string, unknown>>;

    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Checking.', reasoning_content: 'Think about the disk.' });
    expect((messages[1]!.tool_calls as unknown[]).length).toBe(1);
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'call_1', content: '40%' });
  });

  it('rides on a tool-call message without text, and on a final answer', () => {
    const second = { ...REASONING_ITEM, content: [{ type: 'reasoning_text', text: 'Report it.' }] };
    const messages = toChatMessages([user, REASONING_ITEM, fnCall, fnOutput, second, answer]).messages as Array<Record<string, unknown>>;

    expect(messages[1]).toMatchObject({ role: 'assistant', content: null, reasoning_content: 'Think about the disk.' });
    expect(messages[3]).toEqual({ role: 'assistant', content: 'It is 40% full.', reasoning_content: 'Report it.' });
  });

  it('ignores reasoning it cannot read, and reasoning no assistant output follows', () => {
    const opaque = { type: 'reasoning', summary: [{ type: 'summary_text', text: 'A summary.' }], encrypted_content: 'gAAAA-opaque' };
    const messages = toChatMessages([opaque, user, REASONING_ITEM, user, answer]).messages as Array<Record<string, unknown>>;

    expect(messages.some((m) => 'reasoning_content' in m)).toBe(false);
  });

  it('sends no reasoning to an Anthropic seller', () => {
    const body = toChatMessages([user, REASONING_ITEM, answer], 'anthropic-messages');

    expect(JSON.stringify(body)).not.toContain('Think about the disk.');
  });

  it('round-trips what a streamed answer returned', () => {
    const response = completedResponse(streamEvents([
      frame({ reasoning_content: 'Look first.' }),
      frame({ tool_calls: [{ index: 0, id: 'call_9', type: 'function', function: { name: 'run', arguments: '{}' } }] }),
      frame({}, 'tool_calls'),
    ]));
    const replay = [user, ...(response.output as unknown[]), { type: 'function_call_output', call_id: 'call_9', output: 'ok' }];
    const messages = toChatMessages(replay).messages as Array<Record<string, unknown>>;

    expect(messages[1]).toMatchObject({ role: 'assistant', reasoning_content: 'Look first.' });
    expect((messages[1]!.tool_calls as Array<{ id: string }>)[0]!.id).toBe('call_9');
  });
});

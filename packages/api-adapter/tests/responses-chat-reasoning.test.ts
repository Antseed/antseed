import { describe, expect, it } from 'vitest';
import { renderRequestBodyAsOpenAIChat, transformRequest } from '../src/request-transform.js';
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

// A reasoning item as the adapter makes it from a chat answer of `example-model`.
const TAG = 'antseed.reasoning.v1:';
const REASONING_ITEM = {
  type: 'reasoning',
  id: 'rs_chatcmpl-x_0',
  summary: [],
  content: [{ type: 'reasoning_text', text: 'Think about the disk.' }],
  encrypted_content: `${TAG}example-model`,
};

describe('chat reasoning in a translated Responses stream', () => {
  const toolTurn = [
    frame({ role: 'assistant', reasoning_content: 'The user wants ' }),
    frame({ reasoning_content: 'the disk usage.' }),
    frame({ content: 'Checking.' }),
    frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run', arguments: '{"cmd":"df"}' } }] }),
    frame({}, 'tool_calls'),
    `data: ${JSON.stringify({ id: 'chatcmpl-r', model: 'example-model', choices: [], usage: { prompt_tokens: 10, completion_tokens: 30, completion_tokens_details: { reasoning_tokens: 20 } } })}\n\n`,
  ];

  it('streams the reasoning as it comes and closes it when the answer starts', () => {
    const events = streamEvents(toolTurn);
    const itemId = 'rs_chatcmpl-r_0';

    expect(events.slice(1, 8).map((e) => e.event)).toEqual([
      'response.output_item.added',
      'response.content_part.added',
      'response.reasoning_text.delta',
      'response.reasoning_text.delta',
      'response.reasoning_text.done',
      'response.content_part.done',
      'response.output_item.done',
    ]);
    expect(events.slice(1, 8).every((e) => e.data.output_index === 0)).toBe(true);
    expect(events[2]!.data).toMatchObject({ item_id: itemId, content_index: 0, part: { type: 'reasoning_text', text: '' } });
    expect(events.filter((e) => e.event === 'response.reasoning_text.delta').map((e) => e.data.delta)).toEqual(['The user wants ', 'the disk usage.']);
    expect(events[5]!.data).toMatchObject({ item_id: itemId, text: 'The user wants the disk usage.' });
    expect(events[8]).toMatchObject({ event: 'response.output_item.added', data: { output_index: 1, item: { type: 'message' } } });

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

  it('tags the reasoning with the model that wrote it, or the requested one when the seller names none', () => {
    const named = completedResponse(streamEvents(toolTurn));
    const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-responses', fallbackModel: 'requested-model' })!;
    const unnamedFrame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'Hm.' }, finish_reason: 'stop' }] })}\n\n`;
    const sse = adapter.adaptChunk({ requestId: 'r', data: encoder.encode(`${unnamedFrame}data: [DONE]\n\n`), done: true })
      .map((out) => decoder.decode(out.data)).join('');
    const unnamed = JSON.parse(parseSseBuffer(sse).events.find((e) => e.event === 'response.completed')!.data).response;

    expect((named.output as Array<Record<string, unknown>>)[0]!.encrypted_content).toBe(`${TAG}example-model`);
    expect(unnamed.output[0].encrypted_content).toBe(`${TAG}requested-model`);
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

  it('drops reasoning that resumes after the answer started, and keeps what came before', () => {
    const events = streamEvents([frame({ reasoning_content: 'First.' }), frame({ content: 'Done.' }), frame({ reasoning_content: 'Again.' }), frame({}, 'stop')]);

    expect(events.filter((e) => e.event === 'response.reasoning_text.delta').map((e) => e.data.delta)).toEqual(['First.']);
    expect((completedResponse(events).output as Array<Record<string, unknown>>)[0]).toMatchObject({ content: [{ text: 'First.' }] });
  });

  it('opens no reasoning item for blank reasoning', () => {
    const events = streamEvents([frame({ reasoning_content: '\n' }), frame({ content: 'Done.' }), frame({}, 'stop')]);

    expect(itemEvents(events, 'response.output_item.added')).toEqual([{ index: 0, type: 'message' }]);
  });

  it('reads the reasoning of a delta that also carries empty content and reasoning_details', () => {
    const response = completedResponse(streamEvents([
      frame({ role: 'assistant', content: '', reasoning: 'Plan it.', reasoning_details: [{ type: 'reasoning.text', text: 'Plan it.' }] }),
      frame({ content: 'Done.' }),
      frame({}, 'stop'),
    ]));

    expect((response.output as Array<Record<string, unknown>>).map((item) => item.type)).toEqual(['reasoning', 'message']);
    expect((response.output as Array<Record<string, unknown>>)[0]).toMatchObject({ content: [{ type: 'reasoning_text', text: 'Plan it.' }] });
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
      {
        type: 'reasoning',
        id: 'rs_chatcmpl-b_0',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'All checked.' }],
        encrypted_content: `${TAG}example-model`,
      },
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

const responsesBody = (input: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ model: 'example-model', input, tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }], ...extra });

const responsesRequest = (body: Record<string, unknown>) => ({
  requestId: 'r',
  method: 'POST',
  path: '/v1/responses',
  headers: { 'content-type': 'application/json' },
  body: encoder.encode(JSON.stringify(body)),
});

function toChatMessages(
  input: unknown[],
  to: 'openai-chat-completions' | 'anthropic-messages' = 'openai-chat-completions',
  model = 'example-model',
): Record<string, unknown> {
  const result = transformRequest(responsesRequest({ ...responsesBody(input), model }), { from: 'openai-responses', to });
  return JSON.parse(decoder.decode(result!.request.body)) as Record<string, unknown>;
}

const reasoningContents = (body: Record<string, unknown>): unknown[] =>
  (body.messages as Array<Record<string, unknown>>).map((m) => m.reasoning_content).filter((r) => r !== undefined);

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

  it('returns reasoning only to the model that wrote it, whatever the case or provider prefix', () => {
    const input = [user, REASONING_ITEM, preamble, fnCall, fnOutput];
    const other = toChatMessages(input, 'openai-chat-completions', 'other-model');

    expect(reasoningContents(toChatMessages(input, 'openai-chat-completions', 'Example-Model'))).toEqual(['Think about the disk.']);
    expect(reasoningContents(toChatMessages(input, 'openai-chat-completions', 'acme/example-model'))).toEqual(['Think about the disk.']);
    expect(reasoningContents(other)).toEqual([]);
    expect((other.messages as unknown[])[1]).toMatchObject({ role: 'assistant', content: 'Checking.' });
  });

  it('returns no reasoning the adapter did not make, and none in a plain chat rendering', () => {
    const untagged = { type: 'reasoning', summary: [], content: [{ type: 'reasoning_text', text: 'Foreign thought.' }] };
    const plain = renderRequestBodyAsOpenAIChat('openai-responses', responsesBody([user, REASONING_ITEM, preamble, fnCall, fnOutput]))!;

    expect(reasoningContents(toChatMessages([user, untagged, preamble, fnCall, fnOutput]))).toEqual([]);
    expect(reasoningContents(plain)).toEqual([]);
  });

  it('drops reasoning that a built-in tool call separates from the next assistant message', () => {
    const webSearch = { type: 'web_search_call', id: 'ws_1', status: 'completed' };
    const messages = toChatMessages([user, REASONING_ITEM, webSearch, answer]).messages as Array<Record<string, unknown>>;

    expect(messages.some((m) => 'reasoning_content' in m)).toBe(false);
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

describe('Responses reasoning sent on to a Responses seller', () => {
  const untagged = { type: 'reasoning', id: 'rs_other', summary: [], content: [{ type: 'reasoning_text', text: 'Think.' }] };
  const encrypted = { type: 'reasoning', id: 'rs_abc', summary: [], encrypted_content: 'gAAAA-opaque' };
  const passOn = (body: Record<string, unknown>) => {
    const request = responsesRequest(body);
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-responses' })!;
    return { request, result, body: JSON.parse(decoder.decode(result.request.body)) as Record<string, unknown> };
  };

  const ids = (body: Record<string, unknown>) => (body.input as Array<{ type: string; id?: string }>).map((item) => item.id ?? item.type);

  it('drops reasoning items the adapter made, and those without encrypted content, which the seller cannot resolve', () => {
    expect(ids(passOn(responsesBody([user, REASONING_ITEM, untagged, encrypted, answer], { store: false })).body))
      .toEqual(['message', 'rs_abc', 'message']);
  });

  it('keeps reasoning items without encrypted content when the request uses stored state, but not those the adapter made', () => {
    expect(ids(passOn(responsesBody([user, REASONING_ITEM, untagged, answer], { store: true })).body))
      .toEqual(['message', 'rs_other', 'message']);
  });

  it('passes a request with nothing to drop through unchanged', () => {
    const { request, result } = passOn(responsesBody([user, encrypted, answer]));

    expect(result.request).toBe(request);
  });
});

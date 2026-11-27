import { describe, expect, it } from 'vitest';
import type { ServiceApiProtocol } from '../src/types.js';
import { parseSseBuffer } from '../src/utils.js';
import { translateChatBody, translateChatStream } from './chat-stream-support.js';

// A chat seller's answer that its output cap (`finish_reason: "length"`) or a content filter
// (`finish_reason: "content_filter"`) cut off, translated for a Responses or a Messages client.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

const RESPONSES: ServiceApiProtocol = 'openai-responses';
const MESSAGES: ServiceApiProtocol = 'anthropic-messages';
const USAGE = { prompt_tokens: 9, completion_tokens: 16 };

const frame = (delta: Record<string, unknown>, finish: string | null = null, extra: Record<string, unknown> = {}): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-c', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

/** The chat stream of an answer cut by `finish` after text, inside its reasoning, or inside a tool call. */
const cutStream = (finish: string, cut: 'text' | 'reasoning' | 'tool'): string[] => [
  frame({ role: 'assistant', reasoning_content: 'The user wants an essay.' }),
  ...(cut === 'reasoning' ? [] : [frame({ content: 'Essays are' })]),
  ...(cut === 'tool' ? [frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":' } }] })] : []),
  frame({}, finish),
  `data: ${JSON.stringify({ id: 'chatcmpl-c', model: 'example-model', choices: [], usage: USAGE })}\n\n`,
];


const chatBody = (finish: string, cut: 'text' | 'reasoning' | 'tool'): Json => ({
  id: 'chatcmpl-c',
  object: 'chat.completion',
  model: 'example-model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      reasoning_content: 'The user wants an essay.',
      content: cut === 'reasoning' ? null : 'Essays are',
      ...(cut === 'tool' ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":' } }] } : {}),
    },
    finish_reason: finish,
  }],
  usage: USAGE,
});


const buffered = (to: ServiceApiProtocol, body: Json, includeReasoning = true): Json =>
  JSON.parse(decoder.decode(translateChatBody(to, body, false, includeReasoning))) as Json;

const bufferedAsStream = (to: ServiceApiProtocol, body: Json): Array<{ event: string | null; data: Json }> =>
  parseSseBuffer(decoder.decode(translateChatBody(to, body, true))).events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));

const REASONS: Array<{ finish: string; reason: string; stopReason: string | null }> = [
  { finish: 'length', reason: 'max_output_tokens', stopReason: 'max_tokens' },
  // Messages has no stop reason for another vendor's filter (`refusal` is Claude's own). Which one it should get is
  // the stop-reason table's question, left open here: these tests only require that it does not read as finished.
  { finish: 'content_filter', reason: 'content_filter', stopReason: null },
];

/** A Messages stop reason for this cut: the one named, or any but a finished turn's. */
const expectStopReason = (actual: unknown, stopReason: string | null): void => {
  if (stopReason !== null) expect(actual).toBe(stopReason);
  else expect(actual).not.toBe('end_turn');
};

const lastResponseEvent = (events: Array<{ event: string | null; data: Json }>) =>
  events.filter((e) => e.event?.startsWith('response.') && (e.data.response as Json | undefined)?.status !== 'in_progress').at(-1)!;

const itemStatuses = (output: Json[]): Array<[string, unknown]> => output.map((item) => [item.type, item.status]);

describe.each(REASONS)('a chat answer cut by finish_reason $finish, for a Responses client', ({ finish, reason }) => {
  it('streams as response.incomplete with the reason, end_turn false, and the cut message incomplete', () => {
    const events = translateChatStream(RESPONSES, cutStream(finish, 'text'));
    const last = lastResponseEvent(events);

    expect(last.event).toBe('response.incomplete');
    expect(events.filter((e) => e.event === 'response.completed')).toEqual([]);
    expect(last.data.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false, output_text: 'Essays are' });
    expect(itemStatuses(last.data.response.output)).toEqual([['reasoning', undefined], ['message', 'incomplete']]);
    const done = events.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item);
    expect(itemStatuses(done)).toEqual([['reasoning', undefined], ['message', 'incomplete']]);
    expect(events[0]!.data.response).not.toHaveProperty('incomplete_details');
  });

  it('is incomplete in the buffered answer too, sent as JSON or as a stream', () => {
    const answer = buffered(RESPONSES, chatBody(finish, 'text'));
    expect(answer).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false, output_text: 'Essays are' });
    expect(itemStatuses(answer.output)).toEqual([['reasoning', undefined], ['message', 'incomplete']]);

    const events = bufferedAsStream(RESPONSES, chatBody(finish, 'text'));
    expect(events.at(-1)).toMatchObject({ event: 'response.incomplete', data: { response: { status: 'incomplete', incomplete_details: { reason }, end_turn: false } } });
    expect(events.filter((e) => e.event === 'response.completed')).toEqual([]);
  });

  it('keeps the reasoning item when the cap falls inside the reasoning, streamed and buffered', () => {
    const last = lastResponseEvent(translateChatStream(RESPONSES, cutStream(finish, 'reasoning')));
    expect(last.event).toBe('response.incomplete');
    expect(last.data.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false, output_text: '' });
    expect(last.data.response.output).toEqual([expect.objectContaining({ type: 'reasoning', content: [{ type: 'reasoning_text', text: 'The user wants an essay.' }] })]);

    const answer = buffered(RESPONSES, chatBody(finish, 'reasoning'));
    expect(answer).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false });
    expect(answer.output.map((item: Json) => item.type)).toEqual(['reasoning']);
  });

  it('is incomplete with an empty output for a client that keeps no reasoning state', () => {
    const last = lastResponseEvent(translateChatStream(RESPONSES, cutStream(finish, 'reasoning'), false));
    expect(last.event).toBe('response.incomplete');
    expect(last.data.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false, output: [] });

    expect(buffered(RESPONSES, chatBody(finish, 'reasoning'), false)).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false, output: [] });
  });

  it('marks a tool call cut mid-arguments incomplete, and the text before it whole', () => {
    const last = lastResponseEvent(translateChatStream(RESPONSES, cutStream(finish, 'tool')));
    expect(last.data.response).toMatchObject({ status: 'incomplete', incomplete_details: { reason }, end_turn: false });
    expect(itemStatuses(last.data.response.output)).toEqual([['reasoning', undefined], ['message', 'completed'], ['function_call', 'incomplete']]);

    const answer = buffered(RESPONSES, chatBody(finish, 'tool'));
    expect(answer).toMatchObject({ status: 'incomplete', end_turn: false });
    expect(itemStatuses(answer.output)).toEqual([['reasoning', undefined], ['message', 'completed'], ['function_call', 'incomplete']]);
  });
});

describe('a chat answer that finished, for a Responses client', () => {
  it('stays completed, with no incomplete_details, streamed and buffered', () => {
    const last = lastResponseEvent(translateChatStream(RESPONSES, cutStream('stop', 'text')));
    expect(last.event).toBe('response.completed');
    expect(last.data.response).toMatchObject({ status: 'completed', end_turn: true });
    expect(last.data.response).not.toHaveProperty('incomplete_details');
    expect(itemStatuses(last.data.response.output)).toEqual([['reasoning', undefined], ['message', 'completed']]);

    const answer = buffered(RESPONSES, chatBody('stop', 'text'));
    expect(answer).toMatchObject({ status: 'completed', end_turn: true });
    expect(answer).not.toHaveProperty('incomplete_details');
  });
});

describe.each(REASONS)('a chat answer cut by finish_reason $finish, for a Messages client', ({ finish, stopReason }) => {
  const named = stopReason ?? 'that is not end_turn';
  it(`streams a stop_reason ${named}`, () => {
    const events = translateChatStream(MESSAGES, cutStream(finish, 'text'));
    const delta = events.find((e) => e.event === 'message_delta')!;
    expectStopReason(delta.data.delta.stop_reason, stopReason);
    expect(events.at(-1)!.event).toBe('message_stop');
  });

  it(`answers a stop_reason ${named} buffered, sent as JSON or as a stream`, () => {
    expectStopReason(buffered(MESSAGES, chatBody(finish, 'text')).stop_reason, stopReason);
    const events = bufferedAsStream(MESSAGES, chatBody(finish, 'text'));
    expectStopReason(events.find((e) => e.event === 'message_delta')!.data.delta.stop_reason, stopReason);
  });
});

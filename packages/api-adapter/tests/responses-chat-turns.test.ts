import { describe, expect, it } from 'vitest';
import type { SerializedHttpRequest } from '../src/types.js';
import { renderRequestBodyAsOpenAIChat, transformRequest } from '../src/request-transform.js';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import { parseSseBuffer } from '../src/utils.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const EXEC_TOOL = { type: 'function', name: 'run', description: 'Run a command', parameters: { type: 'object' } };

function responsesRequest(body: Record<string, unknown>): SerializedHttpRequest {
  return {
    requestId: 'req-turns',
    method: 'POST',
    path: '/v1/responses',
    headers: { 'content-type': 'application/json' },
    body: encoder.encode(JSON.stringify({ model: 'example-model', ...body })),
  };
}

function toChat(body: Record<string, unknown>): Record<string, unknown> {
  const result = transformRequest(responsesRequest(body), { from: 'openai-responses', to: 'openai-chat-completions' });
  expect(result).not.toBeNull();
  return JSON.parse(decoder.decode(result!.request.body)) as Record<string, unknown>;
}

const assistant = (text: string, phase?: string): Record<string, unknown> => ({
  type: 'message',
  role: 'assistant',
  ...(phase ? { phase } : {}),
  content: [{ type: 'output_text', text }],
});
const call = (id: string, args = '{}'): Record<string, unknown> => ({ type: 'function_call', call_id: id, name: 'run', arguments: args });
const output = (id: string): Record<string, unknown> => ({ type: 'function_call_output', call_id: id, output: `out ${id}` });
const user = (text: string): Record<string, unknown> => ({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });

/** Chat Completions ordering: each assistant message with tool_calls is followed by exactly its tool results. */
function orderingProblems(messages: Array<Record<string, unknown>>): string[] {
  const problems: string[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === 'tool') {
      const owner = messages.slice(0, i).reverse().find((m) => m.role !== 'tool');
      const ids = Array.isArray(owner?.tool_calls) ? (owner.tool_calls as Array<{ id: string }>).map((c) => c.id) : [];
      if (!ids.includes(message.tool_call_id as string)) problems.push(`tool result ${String(message.tool_call_id)} at ${i} has no call before it`);
      continue;
    }
    if (!Array.isArray(message.tool_calls)) continue;
    const ids = (message.tool_calls as Array<{ id: string }>).map((c) => c.id);
    const results = [];
    for (let j = i + 1; j < messages.length && messages[j]!.role === 'tool'; j += 1) results.push(messages[j]!.tool_call_id);
    for (const id of ids) if (!results.includes(id)) problems.push(`call ${id} at ${i} has no result after it`);
  }
  return problems;
}

describe('Responses history sent to a chat model', () => {
  const input = [
    user('Fix the build.'),
    assistant('Checking the config.', 'commentary'),
    { type: 'reasoning', id: 'rs_1', summary: [] },
    call('call_a', '{"cmd":"cat a"}'),
    call('call_b', '{"cmd":"cat b"}'),
    output('call_a'),
    output('call_b'),
    call('call_c'),
    output('call_c'),
    assistant('Now the tests.', 'commentary'),
    call('call_d'),
    output('call_d'),
    assistant('All done.', 'final_answer'),
    user('Thanks.'),
  ];

  it('sends a preamble and the calls it introduces as one assistant message, with no name', () => {
    const messages = toChat({ input, tools: [EXEC_TOOL] }).messages as Array<Record<string, unknown>>;

    expect(messages.map((m) => m.role)).toEqual([
      'user', 'assistant', 'tool', 'tool', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user',
    ]);
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Checking the config.' });
    expect((messages[1]!.tool_calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['call_a', 'call_b']);
    // A call with no preamble keeps the Responses-to-chat empty content.
    expect(messages[4]).toMatchObject({ role: 'assistant', content: null });
    expect(messages[6]).toMatchObject({ role: 'assistant', content: 'Now the tests.' });
    expect((messages[6]!.tool_calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['call_d']);
    expect(messages[8]).toEqual({ role: 'assistant', content: 'All done.' });
    expect(messages.some((m) => 'name' in m)).toBe(false);
    expect(orderingProblems(messages)).toEqual([]);
  });

  it('keeps tool results right after their calls when text follows a call in the same reply', () => {
    const messages = toChat({
      input: [user('Go.'), assistant('First step.', 'commentary'), call('call_a'), assistant('Waiting on it.', 'commentary'), output('call_a')],
      tools: [EXEC_TOOL],
    }).messages as Array<Record<string, unknown>>;

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[1]).toMatchObject({ content: 'First step.\nWaiting on it.' });
    expect(orderingProblems(messages)).toEqual([]);
  });

  it('renders the same grouping for a plain chat rendering of the request', () => {
    const messages = renderRequestBodyAsOpenAIChat('openai-responses', { model: 'example-model', input, tools: [EXEC_TOOL] })!
      .messages as Array<Record<string, unknown>>;

    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Checking the config.' });
    expect((messages[1]!.tool_calls as Array<{ id: string }>).map((c) => c.id)).toEqual(['call_a', 'call_b']);
    expect(orderingProblems(messages)).toEqual([]);
  });
});

describe('Responses request sent to a chat model', () => {
  it('offers only the client tools and sends the instructions unchanged', () => {
    const body = toChat({ instructions: 'Be brief.', input: [user('Hi.')], tools: [EXEC_TOOL] });

    expect((body.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)).toEqual(['run']);
    expect((body.messages as unknown[])[0]).toEqual({ role: 'system', content: 'Be brief.' });
  });

  it('adds no system message when the client sent no instructions', () => {
    const body = toChat({ input: [user('Hi.')], tools: [EXEC_TOOL] });

    expect((body.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(['user']);
  });

  it('passes assistant text that mentions final_answer through unchanged', () => {
    const text = 'Done.\ntool final_answer {}';
    const messages = toChat({ input: [user('Hi.'), assistant(text), user('Next.')] }).messages as Array<Record<string, unknown>>;

    expect(messages[1]).toEqual({ role: 'assistant', content: text });
  });

  it('passes a client tool named final_answer through', () => {
    const finalAnswer = { type: 'function', name: 'final_answer', description: 'Report the result', parameters: { type: 'object' } };
    const body = toChat({ input: [user('Hi.')], tools: [EXEC_TOOL, finalAnswer] });

    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'run', description: 'Run a command', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'final_answer', description: 'Report the result', parameters: { type: 'object' } } },
    ]);
  });
});

type ChatCall = { id: string; name: string; arguments: string };

function chatStream(text: string, calls: ChatCall[]): string {
  const frames: unknown[] = [];
  if (text) frames.push({ id: 'chatcmpl-1', model: 'example-model', choices: [{ index: 0, delta: { content: text }, finish_reason: null }] });
  calls.forEach((c, index) => frames.push({
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } }] }, finish_reason: null }],
  }));
  frames.push({ id: 'chatcmpl-1', model: 'example-model', choices: [{ index: 0, delta: {}, finish_reason: calls.length > 0 ? 'tool_calls' : 'stop' }] });
  return `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
}

/** The final `response` object of a streamed chat answer translated to Responses. */
function streamedResponse(text: string, calls: ChatCall[]): Record<string, unknown> {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-responses' })!;
  const out = adapter.adaptChunk({ requestId: 'r', data: encoder.encode(chatStream(text, calls)), done: true });
  const events = parseSseBuffer(out.map((chunk) => decoder.decode(chunk.data)).join('')).events;
  const completed = events.find((e) => e.event === 'response.completed');
  expect(completed).toBeDefined();
  return JSON.parse(completed!.data).response as Record<string, unknown>;
}

/** The Responses body of a buffered chat answer. */
function bufferedResponse(text: string, calls: ChatCall[]): Record<string, unknown> {
  const body = {
    id: 'chatcmpl-1',
    model: 'example-model',
    choices: [{
      index: 0,
      finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
      message: {
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0
          ? { tool_calls: calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.arguments } })) }
          : {}),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };
  const adapted = transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
    { from: 'openai-chat-completions', to: 'openai-responses' },
  );
  expect(adapted).not.toBeNull();
  return JSON.parse(decoder.decode(adapted!.body)) as Record<string, unknown>;
}

const functionCalls = (response: Record<string, unknown>): Array<{ name: string; arguments: string }> =>
  (response.output as Array<Record<string, unknown>>)
    .filter((item) => item.type === 'function_call')
    .map((item) => ({ name: item.name as string, arguments: item.arguments as string }));

describe('end_turn of a chat answer translated to Responses', () => {
  const cases: Array<{ name: string; text: string; calls: ChatCall[]; endTurn: boolean }> = [
    { name: 'text only', text: 'Let me check the logs.', calls: [], endTurn: true },
    { name: 'text and a tool call', text: 'Checking the logs.', calls: [{ id: 'call_1', name: 'run', arguments: '{"cmd":"ls"}' }], endTurn: false },
    { name: 'a tool call only', text: '', calls: [{ id: 'call_1', name: 'run', arguments: '{}' }], endTurn: false },
    { name: 'a client final_answer call', text: 'Done.', calls: [{ id: 'call_1', name: 'final_answer', arguments: '{}' }], endTurn: false },
  ];

  for (const testCase of cases) {
    it(`is ${testCase.endTurn} for ${testCase.name}, streamed and buffered alike`, () => {
      const streamed = streamedResponse(testCase.text, testCase.calls);
      const buffered = bufferedResponse(testCase.text, testCase.calls);

      expect(streamed.end_turn).toBe(testCase.endTurn);
      expect(buffered.end_turn).toBe(testCase.endTurn);
      expect(functionCalls(streamed)).toEqual(testCase.calls.map(({ name, arguments: args }) => ({ name, arguments: args })));
      expect(functionCalls(buffered)).toEqual(functionCalls(streamed));
    });
  }

  it('passes a client final_answer call through to an Anthropic client', () => {
    const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'anthropic-messages' })!;
    const out = adapter.adaptChunk({
      requestId: 'r',
      data: encoder.encode(chatStream('', [{ id: 'call_1', name: 'final_answer', arguments: '{"summary":"ok"}' }])),
      done: true,
    });
    const starts = parseSseBuffer(out.map((chunk) => decoder.decode(chunk.data)).join('')).events
      .map((e) => (e.data && e.data !== '[DONE]' ? JSON.parse(e.data) : null))
      .filter((d) => d?.type === 'content_block_start');

    expect(starts.map((d) => d.content_block.name)).toEqual(['final_answer']);
  });
});

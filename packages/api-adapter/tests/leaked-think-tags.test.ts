import { describe, expect, it } from 'vitest';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import type { ServiceApiProtocol } from '../src/types.js';
import { parseSseBuffer } from '../src/utils.js';

// Some chat sellers leak the model's think markup into `content`: a lone closing tag (`</mm:think>`, as one
// MiniMax-M3 seller sends it, alone or before the answer's text) or a whole `<think>…</think>` block.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

const frame = (delta: Record<string, unknown>, finish: string | null = null): string =>
  `data: ${JSON.stringify({ id: 'chatcmpl-t', model: 'example-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

const TOOL_CALL = frame({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] });

/** The chat frames of an answer whose content arrives as these deltas. */
const contentFrames = (deltas: string[], toolCallFirst = false): string[] => [
  frame({ role: 'assistant' }),
  ...(toolCallFirst ? [TOOL_CALL] : []),
  ...deltas.map((content) => frame({ content })),
  frame({}, toolCallFirst ? 'tool_calls' : 'stop'),
];

function translateStream(to: ServiceApiProtocol, frames: string[]): Array<{ event: string | null; data: Json }> {
  const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to, fallbackModel: 'example-model', includeReasoning: true })!;
  let sse = '';
  for (const f of frames) for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(f), done: false })) sse += decoder.decode(out.data);
  for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode('data: [DONE]\n\n'), done: true })) sse += decoder.decode(out.data);
  return parseSseBuffer(sse).events
    .filter((e) => e.data !== '[DONE]')
    .map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));
}

/** What a Responses client sees: the streamed text, the streamed reasoning, and the final output's item types. */
function responsesStream(frames: string[]): { text: string; reasoning: string; items: string[]; final: Json } {
  const events = translateStream('openai-responses', frames);
  const final = events.find((e) => e.event === 'response.completed')!.data.response as Json;
  return {
    text: events.filter((e) => e.event === 'response.output_text.delta').map((e) => e.data.delta).join(''),
    reasoning: events.filter((e) => e.event === 'response.reasoning_text.delta').map((e) => e.data.delta).join(''),
    items: (final.output as Json[]).map((item) => item.type),
    final,
  };
}

/** The text a Messages client sees, and the block types it was given. */
function messagesStream(frames: string[]): { text: string; blocks: string[] } {
  const events = translateStream('anthropic-messages', frames);
  return {
    text: events.filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta').map((e) => e.data.delta.text).join(''),
    blocks: events.filter((e) => e.event === 'content_block_start').map((e) => e.data.content_block.type),
  };
}

/** Every way to cut `text` into two deltas, and one character per delta. */
function everySplit(text: string): string[][] {
  const splits: string[][] = [];
  for (let at = 1; at < text.length; at++) splits.push([text.slice(0, at), text.slice(at)]);
  splits.push([...text]);
  return splits;
}

const chatBody = (content: string, reasoning?: string, withToolCall = false): Json => ({
  id: 'chatcmpl-t',
  object: 'chat.completion',
  model: 'example-model',
  choices: [{
    index: 0,
    message: {
      role: 'assistant',
      content,
      ...(reasoning ? { reasoning_content: reasoning } : {}),
      ...(withToolCall ? { tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'exec_command', arguments: '{"cmd":"ls"}' } }] } : {}),
    },
    finish_reason: withToolCall ? 'tool_calls' : 'stop',
  }],
  usage: { prompt_tokens: 5, completion_tokens: 5 },
});

function translateBuffered(to: ServiceApiProtocol, body: Json, streamRequested = false): Uint8Array {
  return transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
    { from: 'openai-chat-completions', to, streamRequested, fallbackModel: 'example-model', includeReasoning: true },
  )!.body;
}

const buffered = (to: ServiceApiProtocol, body: Json): Json => JSON.parse(decoder.decode(translateBuffered(to, body))) as Json;

// Each shape the leak takes, and what the client should get from it.
const SHAPES: Array<{ name: string; content: string; text: string; reasoning: string }> = [
  { name: 'a lone closing tag', content: '</mm:think>', text: '', reasoning: '' },
  { name: 'a closing tag before the text', content: '</mm:think>Now let me rerun the tests.', text: 'Now let me rerun the tests.', reasoning: '' },
  { name: 'a closing tag, a blank line, then the text', content: '</mm:think>\n\nDone.', text: 'Done.', reasoning: '' },
  { name: 'a lone plain closing tag', content: '</think>', text: '', reasoning: '' },
  { name: 'a whole mm:think block', content: '<mm:think>Check the tests first.</mm:think>Running them.', text: 'Running them.', reasoning: 'Check the tests first.' },
  { name: 'a whole think block after a newline', content: '\n<think>Plan it.\nThen do it.</think>\n\nHere is the plan.', text: 'Here is the plan.', reasoning: 'Plan it.\nThen do it.' },
];

describe('think markup leaked at the start of a chat answer', () => {
  describe.each(SHAPES)('$name', ({ content, text, reasoning }) => {
    it('is stripped from a streamed Responses answer however the deltas cut it, and its reasoning streams as reasoning', () => {
      for (const deltas of [[content], ...everySplit(content)]) {
        const seen = responsesStream(contentFrames(deltas));
        expect({ deltas, text: seen.text, reasoning: seen.reasoning }).toEqual({ deltas, text, reasoning });
        expect(seen.final.output_text).toBe(text);
        expect(seen.items).toEqual([...(reasoning ? ['reasoning'] : []), ...(text ? ['message'] : [])]);
      }
    });

    it('is stripped from a streamed Messages answer however the deltas cut it', () => {
      for (const deltas of [[content], ...everySplit(content)]) {
        const seen = messagesStream(contentFrames(deltas));
        expect({ deltas, text: seen.text }).toEqual({ deltas, text });
        expect(seen.blocks).toEqual(text ? ['text'] : []);
      }
    });

    it('is stripped from a buffered Responses and Messages answer, streamed to the client or not', () => {
      const responses = buffered('openai-responses', chatBody(content));
      expect(responses.output_text).toBe(text);
      expect(responses.output.map((item: Json) => item.type)).toEqual([...(reasoning ? ['reasoning'] : []), ...(text ? ['message'] : [])]);
      if (reasoning) expect(responses.output[0].content).toEqual([{ type: 'reasoning_text', text: reasoning }]);

      const messages = buffered('anthropic-messages', chatBody(content));
      expect(messages.content).toEqual(text ? [{ type: 'text', text }] : []);

      const sse = decoder.decode(translateBuffered('openai-responses', chatBody(content), true));
      expect(sse).not.toContain('think>');
    });
  });

  it('is stripped when the text starts after a tool call, as the captured answers had it', () => {
    const seen = responsesStream(contentFrames(['</mm:think>'], true));
    expect(seen.text).toBe('');
    expect(seen.items).toEqual(['function_call']);
    expect(seen.final.output[0]).toMatchObject({ name: 'exec_command', arguments: '{"cmd":"ls"}' });
    expect(seen.final.end_turn).toBe(false);

    const answer = buffered('openai-responses', chatBody('</mm:think>', undefined, true));
    expect(answer.output.map((item: Json) => item.type)).toEqual(['function_call']);
  });

  it('adds a block\'s reasoning after the reasoning the seller sent beside it', () => {
    const answer = buffered('openai-responses', chatBody('<think>Second.</think>Answer.', 'First. '));
    expect(answer.output[0].content).toEqual([{ type: 'reasoning_text', text: 'First. Second.' }]);
    expect(answer.output_text).toBe('Answer.');
  });

  it('streams a think block that never closes as reasoning', () => {
    const seen = responsesStream(contentFrames(['<think>Still ', 'thinking</th']));
    expect(seen.text).toBe('');
    expect(seen.reasoning).toBe('Still thinking</th');
  });
});

describe('think markup that is part of the answer', () => {
  const KEPT = [
    'The `</think>` tag closes a reasoning block.',
    'Models wrap reasoning in <think>…</think> tags.',
    '```xml\n<think>example</think>\n```',
    '`<think>` starts a block.',
    'Let me check.</mm:think>',
    '<thinking>is not a think tag</thinking>',
    '<think',
    '</mm:thin',
    '<thinkpad> is a laptop.',
    '  \n',
    'Plain answer.',
  ];

  it.each(KEPT)('is kept unchanged, streamed however the deltas cut it: %j', (content) => {
    for (const deltas of [[content], ...everySplit(content)]) {
      expect({ deltas, text: responsesStream(contentFrames(deltas)).text }).toEqual({ deltas, text: content });
      expect({ deltas, text: messagesStream(contentFrames(deltas)).text }).toEqual({ deltas, text: content });
    }
  });

  it.each(KEPT)('is kept unchanged in a buffered answer: %j', (content) => {
    expect(buffered('openai-responses', chatBody(content)).output_text).toBe(content);
    expect(buffered('anthropic-messages', chatBody(content)).content).toEqual([{ type: 'text', text: content }]);
  });

  it('is stripped only once, at the start: a second closing tag stays', () => {
    expect(responsesStream(contentFrames(['</mm:think>Before </mm:think> after.'])).text).toBe('Before </mm:think> after.');
    expect(buffered('openai-responses', chatBody('</mm:think>Before </mm:think> after.')).output_text).toBe('Before </mm:think> after.');
  });
});

describe('think markup on a passthrough answer', () => {
  it('is left byte for byte', () => {
    const response = {
      requestId: 'r',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: encoder.encode(JSON.stringify(chatBody('</mm:think>Hi.'))),
    };
    expect(transformResponse(response, { from: 'openai-chat-completions', to: 'openai-chat-completions' })).toBe(response);
    expect(createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-chat-completions' })).toBeNull();
  });
});

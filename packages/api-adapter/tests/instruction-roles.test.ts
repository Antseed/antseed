import { describe, expect, it } from 'vitest';
import { renderRequestBodyAsOpenAIChat, transformRequest } from '../src/request-transform.js';
import type { SerializedHttpRequest, ServiceApiProtocol } from '../src/types.js';

const CHAT = 'openai-chat-completions';
const RESPONSES = 'openai-responses';
const MESSAGES = 'anthropic-messages';

function serialize(from: ServiceApiProtocol, body: Record<string, unknown>): SerializedHttpRequest {
  return {
    requestId: 'req-instruction-roles',
    method: 'POST',
    path: from === RESPONSES ? '/v1/responses' : '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify(body)),
  };
}

function translate(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result = transformRequest(serialize(from, body), { from, to });
  expect(result).not.toBeNull();
  return JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
}

const inputText = (text: string) => ({ type: 'input_text', text });
const userItem = (text: string) => ({ type: 'message', role: 'user', content: [inputText(text)] });
const developerItem = (text: string) => ({ type: 'message', role: 'developer', content: [inputText(text)] });

describe('instructions sent as Chat Completions messages', () => {
  const developer = {
    model: 'm',
    messages: [
      { role: 'developer', content: 'Answer in French.' },
      { role: 'user', content: 'hi' },
    ],
  };

  it('become the system prompt of a Messages request', () => {
    const body = translate(CHAT, MESSAGES, developer);

    expect(body.system).toBe('Answer in French.');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('become the instructions of a Responses request', () => {
    const body = translate(CHAT, RESPONSES, developer);

    expect(body.instructions).toBe('Answer in French.');
    expect(body.input).toEqual([userItem('hi')]);
  });

  it.each([
    ['system', 'developer'],
    ['developer', 'system'],
  ])('keep %s then %s in the order they were sent', (first, second) => {
    const body = translate(CHAT, MESSAGES, {
      model: 'm',
      messages: [
        { role: first, content: 'One.' },
        { role: second, content: 'Two.' },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.system).toBe('One.\n\nTwo.');
  });

  it('read text from content parts', () => {
    const body = translate(CHAT, MESSAGES, {
      model: 'm',
      messages: [
        { role: 'developer', content: [{ type: 'text', text: 'One.' }, { type: 'text', text: 'Two.' }] },
        { role: 'user', content: 'hi' },
      ],
    });

    expect(body.system).toBe('One.\nTwo.');
  });

  it('stay instructions when they arrive between turns, in the order they were sent', () => {
    const body = translate(CHAT, RESPONSES, {
      model: 'm',
      messages: [
        { role: 'developer', content: 'First rule.' },
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'developer', content: 'Second rule.' },
        { role: 'user', content: 'three' },
      ],
    });

    expect(body.instructions).toBe('First rule.\n\nSecond rule.');
    expect(body.input).toEqual([
      userItem('one'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
      userItem('three'),
    ]);
  });

  it('leave a tool result right after its call', () => {
    const body = translate(CHAT, MESSAGES, {
      model: 'm',
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
        },
        { role: 'developer', content: 'Permissions changed.' },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ],
    });

    expect(body.system).toBe('Permissions changed.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'run it' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    ]);
  });

  it('stay the turn to answer when they end the request after an assistant turn', () => {
    const body = translate(CHAT, MESSAGES, {
      model: 'm',
      messages: [
        { role: 'system', content: 'Rule.' },
        { role: 'user', content: 'one' },
        { role: 'assistant', content: 'two' },
        { role: 'developer', content: 'Summarize.' },
      ],
    });

    expect(body.system).toBe('Rule.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'Summarize.' }] },
    ]);
  });

  it('stay the turn to answer when the request holds nothing else', () => {
    const body = translate(CHAT, MESSAGES, { model: 'm', messages: [{ role: 'system', content: 'Write a greeting.' }] });

    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Write a greeting.' }] }]);
  });

  it.each([
    ['developer', ''],
    ['developer', ' \n'],
    ['system', ' \n'],
  ])('add nothing when they carry no text (%s %j)', (role, text) => {
    const body = translate(CHAT, MESSAGES, {
      model: 'm',
      messages: [{ role, content: text }, { role: 'user', content: 'hi' }],
    });

    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });
});

describe('instructions sent as Responses input items', () => {
  const instructed = {
    model: 'm',
    instructions: 'Base.',
    input: [
      developerItem('Stay in the sandbox.'),
      { role: 'system', content: 'Read only.' },
      userItem('hi'),
    ],
  };
  const joined = 'Base.\n\nStay in the sandbox.\n\nRead only.';

  it('follow the instructions in one leading system message of a Chat request', () => {
    const body = translate(RESPONSES, CHAT, instructed);

    expect(body.messages).toEqual([
      { role: 'system', content: joined },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('follow the instructions in the system prompt of a Messages request', () => {
    const body = translate(RESPONSES, MESSAGES, instructed);

    expect(body.system).toBe(joined);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('become the instructions when the request has none of its own', () => {
    const body = translate(RESPONSES, MESSAGES, {
      model: 'm',
      input: [developerItem('Stay in the sandbox.'), userItem('hi')],
    });

    expect(body.system).toBe('Stay in the sandbox.');
  });

  it('read text from a string or from content parts', () => {
    const body = translate(RESPONSES, MESSAGES, {
      model: 'm',
      input: [
        { role: 'developer', content: 'Stay in the sandbox.' },
        { type: 'message', role: 'system', content: [inputText('Read only.'), inputText('No network.')] },
        userItem('hi'),
      ],
    });

    expect(body.system).toBe('Stay in the sandbox.\n\nRead only.\nNo network.');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it('stay instructions when they arrive between turns, in the order they were sent', () => {
    const body = translate(RESPONSES, CHAT, {
      model: 'm',
      input: [
        developerItem('First rule.'),
        userItem('one'),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
        { role: 'system', content: 'Second rule.' },
        userItem('three'),
      ],
    });

    expect(body.messages).toEqual([
      { role: 'system', content: 'First rule.\n\nSecond rule.' },
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
      { role: 'user', content: 'three' },
    ]);
  });

  describe('between a tool call and its result', () => {
    const toolTurn = {
      model: 'm',
      input: [
        userItem('run it'),
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        developerItem('Permissions changed.'),
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    };

    it('leave the result right after the call in a Chat request', () => {
      const body = translate(RESPONSES, CHAT, toolTurn);

      expect(body.messages).toEqual([
        { role: 'system', content: 'Permissions changed.' },
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      ]);
    });

    it('leave the result right after the call in a Messages request', () => {
      const body = translate(RESPONSES, MESSAGES, toolTurn);

      expect(body.system).toBe('Permissions changed.');
      expect(body.messages).toEqual([
        { role: 'user', content: [{ type: 'text', text: 'run it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'call_1', name: 'shell', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
      ]);
    });
  });

  it('stay the turn to answer when they end the request after an assistant turn', () => {
    const body = translate(RESPONSES, MESSAGES, {
      model: 'm',
      instructions: 'Base.',
      input: [
        developerItem('Rule.'),
        userItem('one'),
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'two' }] },
        developerItem('Summarize.'),
      ],
    });

    expect(body.system).toBe('Base.\n\nRule.');
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'Summarize.' }] },
    ]);
  });

  it('stay the turn to answer when the request holds nothing else', () => {
    const body = translate(RESPONSES, MESSAGES, { model: 'm', input: [developerItem('Write a greeting.')] });

    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Write a greeting.' }] }]);
  });

  it.each([
    ['a user turn', [userItem('hi')]],
    ['a tool result', [
      userItem('run it'),
      { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'done' },
    ]],
  ])('join the instructions when they end the request after %s', (_, turns) => {
    const body = translate(RESPONSES, MESSAGES, { model: 'm', input: [...turns, developerItem('Be brief.')] });

    expect(body.system).toBe('Be brief.');
    expect(body.messages).toEqual(translate(RESPONSES, MESSAGES, { model: 'm', input: turns }).messages);
  });

  it('come before what the translation adds for tools', () => {
    const body = translate(RESPONSES, CHAT, {
      ...instructed,
      tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: {} } }],
    });
    const [system] = body.messages as Array<{ role: string; content: string }>;

    expect(system!.role).toBe('system');
    expect(system!.content.startsWith(`${joined}\n\n`)).toBe(true);
  });

  it('lose an image, which a system prompt cannot carry, without inventing a user turn', () => {
    const body = translate(RESPONSES, MESSAGES, {
      model: 'm',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [inputText('Match this style.'), { type: 'input_image', image_url: 'https://example.com/a.png' }],
        },
        userItem('hi'),
      ],
    });

    expect(body.system).toBe('Match this style.');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]);
  });

  it.each(['', ' \n'])('add nothing when they carry no text (%j)', (text) => {
    const body = translate(RESPONSES, CHAT, {
      model: 'm',
      instructions: text,
      input: [developerItem(text), userItem('hi')],
    });

    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('reach a router as the system prompt of the request being ranked', () => {
    const body = renderRequestBodyAsOpenAIChat(RESPONSES, instructed);

    expect(body!.messages).toEqual([
      { role: 'system', content: joined },
      { role: 'user', content: 'hi' },
    ]);
  });
});

describe('instructions sent as messages to a seller that speaks the protocol', () => {
  it.each([
    [CHAT, { model: 'm', messages: [{ role: 'developer', content: 'Rule.' }, { role: 'user', content: 'hi' }] }],
    [RESPONSES, { model: 'm', input: [developerItem('Rule.'), userItem('hi')] }],
  ] as const)('pass through %s untouched', (protocol, body) => {
    const result = transformRequest(serialize(protocol, body), { from: protocol, to: protocol });

    expect(result!.request).toEqual(serialize(protocol, body));
  });
});

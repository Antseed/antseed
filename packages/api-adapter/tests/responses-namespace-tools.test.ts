import { describe, expect, it } from 'vitest';
import { transformRequest } from '../src/request-transform.js';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import { parseSseBuffer } from '../src/utils.js';

// Codex groups some function tools in a `namespace` tool and expects their calls back with the tool's own
// name and a `namespace` field. A Chat Completions seller knows only flat functions.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Json = Record<string, any>;

const fn = (name: string): Json => ({ type: 'function', name, description: `Does ${name}.`, strict: false, parameters: { type: 'object', properties: {} } });

// The tools Codex 0.172 sends: seven functions, one namespace of five, and the hosted web search.
const CODEX_TOOLS: Json[] = [
  fn('exec_command'), fn('write_stdin'), fn('request_user_input'), fn('view_image'),
  {
    type: 'namespace',
    name: 'multi_agent_v1',
    description: 'Tools for spawning and managing sub-agents.',
    tools: [fn('close_agent'), fn('resume_agent'), fn('send_input'), fn('spawn_agent'), fn('wait_agent')],
  },
  fn('get_goal'), fn('create_goal'), fn('update_goal'),
  { type: 'web_search', external_web_access: false },
];

function translate(body: Json) {
  const result = transformRequest(
    { requestId: 'r', method: 'POST', path: '/v1/responses', headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(body)) },
    { from: 'openai-responses', to: 'openai-chat-completions' },
  )!;
  return { ...result, chat: JSON.parse(decoder.decode(result.request.body)) as Json };
}

const toolNames = (chat: Json): string[] => (chat.tools ?? []).map((tool: Json) => tool.function.name);

const request = (tools: Json[], extra: Json = {}): Json => ({ model: 'example-model', stream: true, input: 'Start a helper.', tools, tool_choice: 'auto', ...extra });

describe('Responses tools sent to a chat seller', () => {
  it('flattens a namespace\'s functions into chat functions under their own names, where the namespace was', () => {
    const { chat } = translate(request(CODEX_TOOLS, { parallel_tool_calls: true }));
    expect(toolNames(chat)).toEqual([
      'exec_command', 'write_stdin', 'request_user_input', 'view_image',
      'close_agent', 'resume_agent', 'send_input', 'spawn_agent', 'wait_agent',
      'get_goal', 'create_goal', 'update_goal',
    ]);
    expect(chat.tools.find((tool: Json) => tool.function.name === 'spawn_agent')).toEqual({
      type: 'function',
      function: { name: 'spawn_agent', description: 'Does spawn_agent.', parameters: { type: 'object', properties: {} } },
    });
    expect(chat.tool_choice).toBe('auto');
  });

  it('forwards parallel_tool_calls, true or false, only with tools', () => {
    expect(translate(request(CODEX_TOOLS, { parallel_tool_calls: true })).chat.parallel_tool_calls).toBe(true);
    expect(translate(request(CODEX_TOOLS, { parallel_tool_calls: false })).chat.parallel_tool_calls).toBe(false);
    expect(translate(request(CODEX_TOOLS)).chat).not.toHaveProperty('parallel_tool_calls');
    expect(translate(request([], { parallel_tool_calls: true })).chat).not.toHaveProperty('parallel_tool_calls');
  });

  it('drops hosted tools a chat seller cannot run, and sends no tool fields when only they were offered', () => {
    const hosted = [
      { type: 'web_search', external_web_access: false },
      { type: 'web_search_preview' },
      { type: 'file_search', vector_store_ids: ['vs_1'] },
      { type: 'code_interpreter', container: { type: 'auto' } },
      { type: 'image_generation' },
      { type: 'computer_use_preview', display_width: 1, display_height: 1, environment: 'browser' },
      { type: 'mcp', server_label: 'docs', server_url: 'https://example.com/mcp' },
      { type: 'local_shell' },
    ];
    const { chat } = translate(request(hosted, { parallel_tool_calls: true }));
    expect(chat).not.toHaveProperty('tools');
    expect(chat).not.toHaveProperty('tool_choice');
    expect(chat).not.toHaveProperty('parallel_tool_calls');

    expect(toolNames(translate(request(CODEX_TOOLS)).chat)).not.toContain('web_search');
  });

  it('names a namespace function after its namespace when a plain tool or an earlier namespace has its name', () => {
    const tools = [
      fn('spawn_agent'),
      { type: 'namespace', name: 'multi_agent_v1', description: 'Agents.', tools: [fn('spawn_agent'), fn('wait_agent')] },
      { type: 'namespace', name: 'multi_agent_v2', description: 'Agents again.', tools: [fn('wait_agent')] },
    ];
    const { chat, namespacedTools } = translate(request(tools));
    expect(toolNames(chat)).toEqual(['spawn_agent', 'multi_agent_v1__spawn_agent', 'wait_agent', 'multi_agent_v2__wait_agent']);
    expect(namespacedTools).toEqual({
      multi_agent_v1__spawn_agent: { namespace: 'multi_agent_v1', name: 'spawn_agent' },
      wait_agent: { namespace: 'multi_agent_v1', name: 'wait_agent' },
      multi_agent_v2__wait_agent: { namespace: 'multi_agent_v2', name: 'wait_agent' },
    });
  });

  it('sends an earlier namespace call in the history under the name its tool has in this request', () => {
    const tools = [fn('spawn_agent'), { type: 'namespace', name: 'multi_agent_v1', description: 'Agents.', tools: [fn('spawn_agent'), fn('wait_agent')] }];
    const { chat } = translate(request(tools, {
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Start a helper.' }] },
        { type: 'function_call', call_id: 'call_1', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: '{"message":"hi"}' },
        { type: 'function_call_output', call_id: 'call_1', output: 'agent-1' },
        { type: 'function_call', call_id: 'call_2', name: 'wait_agent', namespace: 'multi_agent_v1', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_2', output: 'done' },
        { type: 'function_call', call_id: 'call_3', name: 'spawn_agent', arguments: '{}' },
        { type: 'function_call_output', call_id: 'call_3', output: 'plain' },
      ],
    }));
    const calls = chat.messages.flatMap((message: Json) => message.tool_calls ?? []).map((call: Json) => call.function.name);
    expect(calls).toEqual(['multi_agent_v1__spawn_agent', 'wait_agent', 'spawn_agent']);
  });

  it('maps nothing for a request without namespaces', () => {
    expect(translate(request([fn('exec_command')])).namespacedTools).toEqual({});
  });
});

// A chat seller's answer that calls a flattened namespace function, a plain one, or a name it was never given.
const COLLIDING_TOOLS = [fn('spawn_agent'), { type: 'namespace', name: 'multi_agent_v1', description: 'Agents.', tools: [fn('spawn_agent'), fn('wait_agent')] }];
const CALLS = [
  { id: 'call_1', name: 'multi_agent_v1__spawn_agent', arguments: '{"message":"hi"}' },
  { id: 'call_2', name: 'wait_agent', arguments: '{}' },
  { id: 'call_3', name: 'spawn_agent', arguments: '{}' },
  { id: 'call_4', name: 'unknown_tool', arguments: '{}' },
];
const EXPECTED_CALLS = [
  { call_id: 'call_1', name: 'spawn_agent', namespace: 'multi_agent_v1', arguments: '{"message":"hi"}' },
  { call_id: 'call_2', name: 'wait_agent', namespace: 'multi_agent_v1', arguments: '{}' },
  { call_id: 'call_3', name: 'spawn_agent', arguments: '{}' },
  { call_id: 'call_4', name: 'unknown_tool', arguments: '{}' },
];

const callsOf = (items: Json[]): Json[] => items
  .filter((item) => item.type === 'function_call')
  .map(({ call_id, name, namespace, arguments: args }) => ({ call_id, name, ...(namespace !== undefined ? { namespace } : {}), arguments: args }));

describe('a chat seller\'s calls to flattened namespace tools, returned to a Responses client', () => {
  const { namespacedTools } = translate(request(COLLIDING_TOOLS));

  it('carry the tool\'s own name and its namespace in a stream', () => {
    const adapter = createStreamingAdapter({ from: 'openai-chat-completions', to: 'openai-responses', namespacedTools })!;
    const frame = (delta: Json, finish: string | null = null) => `data: ${JSON.stringify({ id: 'chatcmpl-n', model: 'm', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let sse = '';
    const feed = (data: string, done = false) => {
      for (const out of adapter.adaptChunk({ requestId: 'r', data: encoder.encode(data), done })) sse += decoder.decode(out.data);
    };
    feed(frame({ role: 'assistant' }));
    for (const [index, call] of CALLS.entries()) {
      feed(frame({ tool_calls: [{ index, id: call.id, type: 'function', function: { name: call.name, arguments: '' } }] }));
      feed(frame({ tool_calls: [{ index, function: { arguments: call.arguments } }] }));
    }
    feed(frame({}, 'tool_calls'));
    feed('data: [DONE]\n\n', true);

    const events = parseSseBuffer(sse).events.filter((e) => e.data !== '[DONE]').map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));
    const added = events.filter((e) => e.event === 'response.output_item.added').map((e) => e.data.item);
    expect(callsOf(added).map(({ arguments: _a, ...call }) => call)).toEqual(EXPECTED_CALLS.map(({ arguments: _a, ...call }) => call));
    expect(callsOf(events.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item))).toEqual(EXPECTED_CALLS);
    const completed = events.find((e) => e.event === 'response.completed')!.data.response;
    expect(callsOf(completed.output)).toEqual(EXPECTED_CALLS);
    const argsDone = events.filter((e) => e.event === 'response.function_call_arguments.done').map((e) => e.data.name);
    expect(argsDone).toEqual(['spawn_agent', 'wait_agent', 'spawn_agent', 'unknown_tool']);
  });

  const chatAnswer = {
    id: 'chatcmpl-n',
    object: 'chat.completion',
    model: 'm',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: null, tool_calls: CALLS.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 1, completion_tokens: 1 },
  };
  const buffered = (streamRequested: boolean) => transformResponse(
    { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(chatAnswer)) },
    { from: 'openai-chat-completions', to: 'openai-responses', streamRequested, namespacedTools },
  )!;

  it('carry the tool\'s own name and its namespace in a buffered answer, sent as JSON or as a stream', () => {
    const answer = JSON.parse(decoder.decode(buffered(false).body)) as Json;
    expect(callsOf(answer.output)).toEqual(EXPECTED_CALLS);

    const events = parseSseBuffer(decoder.decode(buffered(true).body)).events.filter((e) => e.data !== '[DONE]').map((e) => ({ event: e.event, data: JSON.parse(e.data) as Json }));
    expect(callsOf(events.filter((e) => e.event === 'response.output_item.done').map((e) => e.data.item))).toEqual(EXPECTED_CALLS);
  });

  it('carry no namespace without a map', () => {
    const answer = JSON.parse(decoder.decode(transformResponse(
      { requestId: 'r', statusCode: 200, headers: { 'content-type': 'application/json' }, body: encoder.encode(JSON.stringify(chatAnswer)) },
      { from: 'openai-chat-completions', to: 'openai-responses' },
    )!.body)) as Json;
    expect(callsOf(answer.output).map((call) => call.name)).toEqual(CALLS.map((call) => call.name));
    expect(callsOf(answer.output).some((call) => 'namespace' in call)).toBe(false);
  });
});

describe('parallel_tool_calls from a Chat Completions client to a Responses seller', () => {
  it('is forwarded with the tools', () => {
    const result = transformRequest(
      {
        requestId: 'r', method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'application/json' },
        body: encoder.encode(JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: { name: 'run', parameters: { type: 'object' } } }], parallel_tool_calls: false })),
      },
      { from: 'openai-chat-completions', to: 'openai-responses' },
    )!;
    expect(JSON.parse(decoder.decode(result.request.body)).parallel_tool_calls).toBe(false);
  });
});

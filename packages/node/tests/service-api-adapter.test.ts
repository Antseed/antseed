import { describe, it, expect } from 'vitest';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';
import type { ServiceApiProtocol } from '../src/discovery/peer-metadata.js';
import {
  createStreamingAdapter,
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
} from '../src/proxy/service-api-adapter.js';

function makeRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
    },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'claude-sonnet',
      max_tokens: 256,
      stream: true,
      system: 'be helpful',
      messages: [
        { role: 'user', content: 'hello' },
      ],
      tools: [
        {
          name: 'write',
          description: 'Write a file',
          input_schema: {
            type: 'object',
            properties: {
              path: { type: 'string' },
            },
            required: ['path'],
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'write' },
    })),
    ...overrides,
  };
}

function makeOpenAIResponse(overrides?: Partial<SerializedHttpResponse>): SerializedHttpResponse {
  return {
    requestId: 'req-1',
    statusCode: 200,
    headers: {
      'content-type': 'application/json',
    },
    body: new TextEncoder().encode(JSON.stringify({
      id: 'chatcmpl-1',
      model: 'gpt-4.1',
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: 'Working on it',
            tool_calls: [
              {
                id: 'call_123',
                type: 'function',
                function: {
                  name: 'write',
                  arguments: '{"path":"hello.txt"}',
                },
              },
            ],
          },
        },
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
      },
    })),
    ...overrides,
  };
}

function adaptResponseForTest(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  response: SerializedHttpResponse,
  options: { fallbackModel?: string | null; streamRequested?: boolean } = {},
): SerializedHttpResponse {
  const transformed = transformResponse(response, { from, to, ...options });
  expect(transformed).not.toBeNull();
  return transformed!;
}

function createStreamAdapterForTest(
  from: ServiceApiProtocol,
  to: ServiceApiProtocol,
  fallbackModel: string | null,
) {
  const adapter = createStreamingAdapter({ from, to, fallbackModel });
  expect(adapter).not.toBeNull();
  return adapter!;
}

function parseSseEvents(sseText: string): Array<{ event: string | null; data: string }> {
  return sseText
    .trim()
    .split('\n\n')
    .filter((chunk) => chunk.length > 0)
    .map((chunk) => {
      const lines = chunk.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: ')) ?? null;
      const dataLine = lines.find((line) => line.startsWith('data: ')) ?? 'data: ';
      return {
        event: eventLine ? eventLine.slice('event: '.length) : null,
        data: dataLine.slice('data: '.length),
      };
    });
}

describe('detectRequestServiceApiProtocol', () => {
  it('detects anthropic messages from path', () => {
    expect(detectRequestServiceApiProtocol(makeRequest())).toBe('anthropic-messages');
  });

  it('detects openai chat completions from path', () => {
    expect(
      detectRequestServiceApiProtocol(makeRequest({ path: '/v1/chat/completions' })),
    ).toBe('openai-chat-completions');
  });

  it('detects typesafe systemone from path', () => {
    expect(
      detectRequestServiceApiProtocol(makeRequest({ path: '/v1/systemone' })),
    ).toBe('typesafe-systemone');
  });
});

describe('selectTargetProtocolForRequest', () => {
  it('never adapts systemone requests onto chat protocols', () => {
    expect(selectTargetProtocolForRequest('typesafe-systemone', ['openai-chat-completions'])).toBeNull();
    expect(selectTargetProtocolForRequest('typesafe-systemone', ['typesafe-systemone'])).toEqual({
      targetProtocol: 'typesafe-systemone',
      requiresTransform: false,
    });
  });

  it('selects passthrough protocol when supported directly', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['anthropic-messages']);
    expect(selected).toEqual({ targetProtocol: 'anthropic-messages', requiresTransform: false });
  });

  it('selects transform to openai chat when anthropic is unavailable', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['openai-chat-completions']);
    expect(selected).toEqual({ targetProtocol: 'openai-chat-completions', requiresTransform: true });
  });
});

describe('inferProviderDefaultServiceApiProtocols', () => {
  it('infers anthropic providers', () => {
    expect(inferProviderDefaultServiceApiProtocols('claude-oauth')).toEqual(['anthropic-messages']);
  });

  it('keeps generic openai fallback chat-only', () => {
    expect(inferProviderDefaultServiceApiProtocols('openai')).toEqual([
      'openai-chat-completions',
    ]);
  });

  it('keeps local-llm fallback chat-only', () => {
    expect(inferProviderDefaultServiceApiProtocols('local-llm')).toEqual(['openai-chat-completions']);
  });
});

describe('transformRequest anthropic to chat', () => {
  it('rewrites request path/body and strips anthropic-only headers', () => {
    const transformed = transformRequest(makeRequest(), { from: 'anthropic-messages', to: 'openai-chat-completions' });
    expect(transformed).not.toBeNull();
    expect(transformed!.request.path).toBe('/v1/chat/completions');
    expect(transformed!.streamRequested).toBe(true);
    expect(transformed!.request.headers['anthropic-version']).toBeUndefined();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet');
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.tools)).toBe(true);
    expect(body.tool_choice).toEqual({
      type: 'function',
      function: {
        name: 'write',
      },
    });
  });
});

describe('transformResponse chat to anthropic', () => {
  it('maps non-stream openai chat response to anthropic message payload', () => {
    const transformed = adaptResponseForTest('openai-chat-completions', 'anthropic-messages', makeOpenAIResponse(), {
      streamRequested: false,
      fallbackModel: 'fallback-model',
    });
    expect(transformed.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(transformed.body)) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('tool_use');
    expect(Array.isArray(body.content)).toBe(true);

    const content = body.content as Array<Record<string, unknown>>;
    expect(content.some((block) => block.type === 'text')).toBe(true);
    expect(content.some((block) => block.type === 'tool_use')).toBe(true);
  });

  it('maps to anthropic SSE when stream is requested', () => {
    const transformed = adaptResponseForTest('openai-chat-completions', 'anthropic-messages', makeOpenAIResponse(), {
      streamRequested: true,
      fallbackModel: 'fallback-model',
    });
    expect(transformed.headers['content-type']).toBe('text/event-stream');
    const sseText = new TextDecoder().decode(transformed.body);
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('event: content_block_start');
    expect(sseText).toContain('event: message_stop');
  });

  it('emits input_json_delta for tool_use blocks in SSE stream', () => {
    const transformed = adaptResponseForTest('openai-chat-completions', 'anthropic-messages', makeOpenAIResponse(), {
      streamRequested: true,
      fallbackModel: 'fallback-model',
    });
    const sseText = new TextDecoder().decode(transformed.body);

    // Parse SSE events
    const events: Array<{ event: string; data: Record<string, unknown> }> = [];
    for (const chunk of sseText.split('\n\n')) {
      const lines = chunk.split('\n').filter((l) => l.length > 0);
      if (lines.length < 2) continue;
      const event = lines[0].replace('event: ', '');
      const data = JSON.parse(lines[1].replace('data: ', '')) as Record<string, unknown>;
      events.push({ event, data });
    }

    // Find content_block_start for tool_use
    const toolStart = events.find(
      (e) => e.event === 'content_block_start'
        && (e.data.content_block as Record<string, unknown>)?.type === 'tool_use',
    );
    expect(toolStart).toBeDefined();
    // input should be empty in content_block_start per Anthropic spec
    expect((toolStart!.data.content_block as Record<string, unknown>).input).toEqual({});

    // Find input_json_delta for tool_use arguments
    const toolDelta = events.find(
      (e) => e.event === 'content_block_delta'
        && (e.data.delta as Record<string, unknown>)?.type === 'input_json_delta',
    );
    expect(toolDelta).toBeDefined();
    const delta = toolDelta!.data.delta as Record<string, unknown>;
    expect(delta.type).toBe('input_json_delta');
    const parsedArgs = JSON.parse(delta.partial_json as string) as Record<string, unknown>;
    expect(parsedArgs).toEqual({ path: 'hello.txt' });
  });
});

describe('createStreamingAdapter chat to anthropic', () => {
  it('converts openai chat deltas into anthropic SSE frames incrementally', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'anthropic-messages', '');
    const start = adapter.adaptStart(makeOpenAIResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    }));
    expect(start.headers['content-type']).toBe('text/event-stream');

    const chunks = adapter.adaptChunk({
      requestId: 'req-1',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-1","model":"gpt-4.1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });
    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('event: content_block_delta');
    expect(sseText).toContain('"text":"Hello"');
    expect(sseText).toContain('"text":" world"');
    expect(sseText).toContain('event: message_stop');
  });

  it('converts streamed tool call deltas into anthropic tool_use events', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'anthropic-messages', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-tool',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-tool","model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hello.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: content_block_start');
    expect(sseText).toContain('"type":"tool_use"');
    expect(sseText).toContain('"name":"write"');
    expect(sseText).toContain('event: content_block_delta');
    expect(sseText).toContain('"type":"input_json_delta"');
    expect(sseText).toContain('\\"path\\"');
    expect(sseText).toContain('hello.txt');
  });

  it('uses block index 0 for tool-only anthropic streams', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'anthropic-messages', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-tool-only-index',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-tool-only","model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\":\\"hello.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const toolStart = events.find(
      (event) => event.event === 'content_block_start' && event.data.includes('"id":"call_1"'),
    );
    const toolDelta = events.find(
      (event) => event.event === 'content_block_delta' && event.data.includes('"partial_json"'),
    );
    const toolStop = events.find(
      (event) => event.event === 'content_block_stop' && event.data.includes('"index":0'),
    );

    expect(toolStart?.data).toContain('"index":0');
    expect(toolDelta?.data).toContain('"index":0');
    expect(toolStop).toBeDefined();
  });

  it('closes the text block before opening a tool block', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'anthropic-messages', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-mixed',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-mixed","model":"gpt-4.1","choices":[{"delta":{"content":"Thinking...","tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\":\\"hello.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const eventNames = events.map((event) => event.event);
    const textStopIndex = eventNames.findIndex((event) => event === 'content_block_stop');
    const toolStartIndex = events.findIndex(
      (event) => event.event === 'content_block_start' && event.data.includes('"tool_use"'),
    );

    expect(textStopIndex).toBeGreaterThan(-1);
    expect(toolStartIndex).toBeGreaterThan(-1);
    expect(textStopIndex).toBeLessThan(toolStartIndex);
  });

  it('closes the previous tool block before opening the next tool block', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'anthropic-messages', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-multi-tool',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-multi","model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\":\\"hello.txt\\"}"}}]},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","type":"function","function":{"name":"search","arguments":"{\\"q\\":\\"antseed\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const firstToolStartIndex = events.findIndex(
      (event) => event.event === 'content_block_start' && event.data.includes('"id":"call_1"'),
    );
    const firstToolStopIndex = events.findIndex(
      (event) => event.event === 'content_block_stop' && event.data.includes('"index":0'),
    );
    const secondToolStartIndex = events.findIndex(
      (event) => event.event === 'content_block_start' && event.data.includes('"id":"call_2"'),
    );

    expect(firstToolStartIndex).toBeGreaterThan(-1);
    expect(firstToolStopIndex).toBeGreaterThan(-1);
    expect(secondToolStartIndex).toBeGreaterThan(-1);
    expect(firstToolStopIndex).toBeLessThan(secondToolStartIndex);
  });
});

// ---------------------------------------------------------------------------
// OpenAI Responses API tests
// ---------------------------------------------------------------------------

function makeResponsesRequest(overrides?: Partial<SerializedHttpRequest>): SerializedHttpRequest {
  return {
    requestId: 'req-resp-1',
    method: 'POST',
    path: '/v1/responses',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer sk-test',
    },
    body: new TextEncoder().encode(JSON.stringify({
      model: 'gpt-4.1',
      input: 'What is the capital of France?',
      instructions: 'Answer concisely',
      max_output_tokens: 100,
      temperature: 0.5,
    })),
    ...overrides,
  };
}

describe('detectRequestServiceApiProtocol – responses', () => {
  it('detects openai responses from /v1/responses path', () => {
    expect(
      detectRequestServiceApiProtocol(makeResponsesRequest()),
    ).toBe('openai-responses');
  });
});

describe('selectTargetProtocolForRequest – responses', () => {
  it('selects passthrough when openai-responses is supported', () => {
    const selected = selectTargetProtocolForRequest('openai-responses', ['openai-responses']);
    expect(selected).toEqual({ targetProtocol: 'openai-responses', requiresTransform: false });
  });

  it('falls back to openai-chat-completions when responses is unsupported', () => {
    const selected = selectTargetProtocolForRequest('openai-responses', ['openai-chat-completions']);
    expect(selected).toEqual({ targetProtocol: 'openai-chat-completions', requiresTransform: true });
  });

  it('falls back to anthropic messages when responses and chat are unsupported', () => {
    const selected = selectTargetProtocolForRequest('openai-responses', ['anthropic-messages']);
    expect(selected).toEqual({ targetProtocol: 'anthropic-messages', requiresTransform: true });
  });
});

describe('transformRequest responses to chat', () => {
  it('converts string input to chat completions request', () => {
    const result = transformRequest(makeResponsesRequest(), { from: 'openai-responses', to: 'openai-chat-completions' });
    expect(result).not.toBeNull();
    expect(result!.request.path).toBe('/v1/chat/completions');
    expect(result!.requestedModel).toBe('gpt-4.1');
    expect(result!.streamRequested).toBe(false);

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4.1');
    expect(body.max_tokens).toBe(100);
    expect(body.temperature).toBe(0.5);
    expect(body.store).toBeUndefined();

    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'system', content: 'Answer concisely' });
    expect(messages[1]).toEqual({ role: 'user', content: 'What is the capital of France?' });
  });

  it('converts array input to messages', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: 'Hello' },
          { role: 'assistant', content: 'Hi there!' },
          { role: 'user', content: 'How are you?' },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    expect(result).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello' });
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi there!' });
    expect(messages[2]).toEqual({ role: 'user', content: 'How are you?' });
  });

  it('handles input_text content blocks in message input', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'Hello from input_text' }] },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: 'user', content: 'Hello from input_text' });
  });

  it('preserves streamRequested on the upstream request', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'test',
        stream: true,
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    expect(result!.streamRequested).toBe(true);

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('converts Responses API flat tools to Chat Completions nested format', () => {
    const responsesTools = [{ type: 'function', name: 'search', description: 'Search the web', parameters: { type: 'object' } }];
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'test',
        tools: responsesTools,
        tool_choice: 'auto',
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.tools).toEqual([{
      type: 'function',
      function: { name: 'search', description: 'Search the web', parameters: { type: 'object' } },
    }, {
      type: 'function',
      function: { name: 'final_answer', parameters: { properties: {}, type: 'object' } },
    }]);
    expect(body.tool_choice).toBe('auto');
  });

  it('omits tools when only built-in Responses tools are provided', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'test',
        tools: [{ type: 'web_search' }],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.tools).toBeUndefined();
  });

  it('remaps object tool_choice to Chat Completions nested format', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'test',
        tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'search' },
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.tool_choice).toEqual({ type: 'function', function: { name: 'search' } });
  });

  it('uses call_id rather than item id for multi-turn tool correlation', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          {
            type: 'function_call',
            id: 'fc_123',
            call_id: 'call_search_1',
            name: 'search',
            arguments: '{"q":"antseed"}',
          },
          {
            type: 'function_call_output',
            call_id: 'call_search_1',
            output: 'done',
          },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages[0]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: 'call_search_1',
        type: 'function',
        function: {
          name: 'search',
          arguments: '{"q":"antseed"}',
        },
      }],
    });
    expect(messages[1]).toEqual({
      role: 'tool',
      tool_call_id: 'call_search_1',
      content: 'done',
    });
  });

  it('returns null for unsupported request protocols', () => {
    const request = makeResponsesRequest();
    expect(transformRequest(request, { from: 'openai-completions', to: 'openai-chat-completions' })).toBeNull();
  });
});

describe('transformResponse chat to responses', () => {
  it('maps text response to responses format', () => {
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-abc',
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Paris is the capital of France.' },
        }],
        usage: { prompt_tokens: 15, completion_tokens: 8 },
      })),
    });

    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse, { fallbackModel: 'fallback' });
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;

    expect(body.id).toBe('chatcmpl-abc');
    expect(body.object).toBe('response');
    expect(body.model).toBe('gpt-4.1');
    expect(body.output_text).toBe('Paris is the capital of France.');

    const output = body.output as Array<Record<string, unknown>>;
    expect(output).toHaveLength(1);
    expect(output[0].type).toBe('message');
    expect(output[0].id).toBe('msg_chatcmpl-abc_1');
    expect(output[0].role).toBe('assistant');
    expect(output[0].status).toBe('completed');

    const content = output[0].content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({
      type: 'output_text',
      text: 'Paris is the capital of France.',
      annotations: [],
    });

    const usage = body.usage as Record<string, unknown>;
    expect(usage.input_tokens).toBe(15);
    expect(usage.output_tokens).toBe(8);
    expect(usage.total_tokens).toBe(23);
  });

  it('maps tool calls to function_call items', () => {
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', makeOpenAIResponse(), {
      fallbackModel: 'fallback',
    });
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;

    // Should have message item + function_call item
    const functionCall = output.find((item) => item.type === 'function_call');
    expect(functionCall).toBeDefined();
    expect(functionCall!.name).toBe('write');
    expect(functionCall!.id).toBe('fc_call_123');
    expect(functionCall!.call_id).toBe('call_123');
    expect(functionCall!.arguments).toBe('{"path":"hello.txt"}');
  });

  it('uses fallback service when response has none', () => {
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-x',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'hi' },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      })),
    });
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse, {
      fallbackModel: 'my-model',
    });
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.model).toBe('my-model');
  });

  it('returns SSE stream when streamRequested is true', () => {
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-stream',
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Hello!' },
        }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      })),
    });
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse, {
      fallbackModel: 'fallback',
      streamRequested: true,
    });
    expect(result.headers['content-type']).toBe('text/event-stream');
    expect(result.headers['cache-control']).toBe('no-cache');
    const sseText = new TextDecoder().decode(result.body);
    const events = parseSseEvents(sseText);
    expect(events.at(-1)).toEqual({ event: null, data: '[DONE]' });

    const created = events.find((event) => event.event === 'response.created');
    expect(created).toBeDefined();
    expect(JSON.parse(created!.data)).toMatchObject({
      type: 'response.created',
      sequence_number: 0,
      response: {
        id: 'chatcmpl-stream',
        status: 'in_progress',
        output: [],
        output_text: '',
      },
    });

    const added = events.find((event) => event.event === 'response.output_item.added');
    expect(added).toBeDefined();
    expect(JSON.parse(added!.data)).toMatchObject({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'message',
        id: 'msg_chatcmpl-stream_1',
        status: 'in_progress',
        content: [{ type: 'output_text', text: '', annotations: [] }],
      },
    });

    const delta = events.find((event) => event.event === 'response.output_text.delta');
    expect(delta).toBeDefined();
    expect(JSON.parse(delta!.data)).toMatchObject({
      type: 'response.output_text.delta',
      item_id: 'msg_chatcmpl-stream_1',
      output_index: 0,
      content_index: 0,
      delta: 'Hello!',
      logprobs: [],
    });

    const completed = events.find((event) => event.event === 'response.completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.data)).toMatchObject({
      type: 'response.completed',
      response: {
        id: 'chatcmpl-stream',
        status: 'completed',
        output_text: 'Hello!',
      },
    });
  });

  it('emits correlated function call SSE events', () => {
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', makeOpenAIResponse(), {
      fallbackModel: 'fallback',
      streamRequested: true,
    });
    const events = parseSseEvents(new TextDecoder().decode(result.body));

    const added = events.find((event) => event.event === 'response.output_item.added' && event.data.includes('"function_call"'));
    expect(added).toBeDefined();
    expect(JSON.parse(added!.data)).toMatchObject({
      type: 'response.output_item.added',
      output_index: 1,
      item: {
        type: 'function_call',
        id: 'fc_call_123',
        call_id: 'call_123',
        name: 'write',
        arguments: '',
        status: 'in_progress',
      },
    });

    const delta = events.find((event) => event.event === 'response.function_call_arguments.delta');
    expect(delta).toBeDefined();
    expect(JSON.parse(delta!.data)).toMatchObject({
      type: 'response.function_call_arguments.delta',
      output_index: 1,
      item_id: 'fc_call_123',
      call_id: 'call_123',
      delta: '{"path":"hello.txt"}',
    });

    const done = events.find((event) => event.event === 'response.function_call_arguments.done');
    expect(done).toBeDefined();
    expect(JSON.parse(done!.data)).toMatchObject({
      type: 'response.function_call_arguments.done',
      output_index: 1,
      item_id: 'fc_call_123',
      call_id: 'call_123',
      name: 'write',
      arguments: '{"path":"hello.txt"}',
    });
  });

  it('normalizes error responses to responses-compatible json', () => {
    const errorResponse = makeOpenAIResponse({
      statusCode: 429,
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      })),
    });
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', errorResponse, {});
    expect(result.statusCode).toBe(429);
    expect(result.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.error).toBeDefined();
    expect(body.error).toEqual({
      message: 'Rate limit exceeded',
      type: 'rate_limit_error',
    });
  });

  it('returns SSE error frames when streamRequested is true', () => {
    const errorResponse = makeOpenAIResponse({
      statusCode: 429,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      })),
    });
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', errorResponse, {
      streamRequested: true,
    });
    expect(result.statusCode).toBe(429);
    expect(result.headers['content-type']).toBe('text/event-stream');
    expect(result.headers['cache-control']).toBe('no-cache');
    const text = new TextDecoder().decode(result.body);
    expect(text).toContain('event: error');
    expect(text).toContain('"message":"Rate limit exceeded"');
    expect(text).toContain('"type":"rate_limit_error"');
  });
});

describe('createStreamingAdapter chat to responses', () => {
  it('converts openai chat deltas into responses SSE frames incrementally', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'openai-responses', '');
    const start = adapter.adaptStart(makeOpenAIResponse({
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    }));
    expect(start.headers['content-type']).toBe('text/event-stream');

    const chunks = adapter.adaptChunk({
      requestId: 'req-resp-1',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-stream","model":"gpt-4.1","choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"content":" world"},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: response.created');
    expect(sseText).toContain('event: response.output_text.delta');
    expect(sseText).toContain('"delta":"Hello"');
    expect(sseText).toContain('"delta":" world"');
    expect(sseText).toContain('event: response.completed');
    expect(sseText).toContain('data: [DONE]');
  });

  it('converts streamed tool call deltas into responses function_call events', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'openai-responses', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-tool',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-tool","model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hello.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: response.output_item.added');
    expect(sseText).toContain('"type":"function_call"');
    expect(sseText).toContain('event: response.function_call_arguments.delta');
    expect(sseText).toContain('event: response.function_call_arguments.done');
    expect(sseText).toContain('"name":"write"');
    expect(sseText).toContain('hello.txt');
  });

  it('emits response.created first and avoids phantom text items for tool-only streams', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'openai-responses', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-tool-only',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-tool","model":"gpt-4.1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"write","arguments":"{\\"path\\""}}]},"finish_reason":null}]}\n\n'
        + 'data: {"usage":{"prompt_tokens":7,"completion_tokens":3},"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\\"hello.txt\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));

    expect(events[0]?.event).toBe('response.created');

    const firstAdded = events.find((event) => event.event === 'response.output_item.added');
    expect(firstAdded).toBeDefined();
    expect(JSON.parse(firstAdded!.data)).toMatchObject({
      type: 'response.output_item.added',
      output_index: 0,
      item: {
        type: 'function_call',
        id: 'fc_call_1',
      },
    });

    const completed = events.find((event) => event.event === 'response.completed');
    expect(completed).toBeDefined();
    expect(JSON.parse(completed!.data)).toMatchObject({
      type: 'response.completed',
      response: {
        output: [{
          type: 'function_call',
          id: 'fc_call_1',
          call_id: 'call_1',
          name: 'write',
          arguments: '{"path":"hello.txt"}',
          status: 'completed',
        }],
        output_text: '',
        usage: {
          input_tokens: 7,
          output_tokens: 3,
          total_tokens: 10,
        },
      },
    });

    expect(events.some((event) => event.event === 'response.output_text.delta')).toBe(false);
    expect(events.some((event) => event.event === 'response.output_text.done')).toBe(false);
  });
});

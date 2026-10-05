import { describe, it, expect, vi } from 'vitest';
import type { SerializedHttpRequest, SerializedHttpResponse, ServiceApiProtocol } from '../src/types.js';
import { transformRequest } from '../src/request-transform.js';
import { transformResponse } from '../src/response-transform.js';
import { createStreamingAdapter } from '../src/stream-transform.js';
import {
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  normalizeAnthropicMessagesRequestBody,
  renderCanonicalRequestToAnthropicMessagesBody,
} from '../src/canonical.js';
import {
  detectRequestServiceApiProtocol,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
} from '../src/detect.js';

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

function makeAnthropicResponse(overrides?: Partial<SerializedHttpResponse>): SerializedHttpResponse {
  return {
    requestId: 'req-anthropic-1',
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet',
      content: [
        { type: 'text', text: 'Working on it' },
        { type: 'tool_use', id: 'toolu_1', name: 'write', input: { path: 'hello.txt' } },
      ],
      stop_reason: 'tool_use',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 5 },
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

  it('detects openai images from the generations and edits paths', () => {
    expect(
      detectRequestServiceApiProtocol(makeRequest({ path: '/v1/images/generations' })),
    ).toBe('openai-images');
    expect(
      detectRequestServiceApiProtocol(makeRequest({ path: '/v1/images/edits' })),
    ).toBe('openai-images');
  });
});

describe('selectTargetProtocolForRequest', () => {
  it('selects passthrough protocol when supported directly', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['anthropic-messages']);
    expect(selected).toEqual({ targetProtocol: 'anthropic-messages', requiresTransform: false });
  });

  it('selects transform to openai chat when anthropic is unavailable', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['openai-chat-completions']);
    expect(selected).toEqual({ targetProtocol: 'openai-chat-completions', requiresTransform: true });
  });

  it('selects transform to openai responses when chat is unavailable', () => {
    const selected = selectTargetProtocolForRequest('anthropic-messages', ['openai-responses']);
    expect(selected).toEqual({ targetProtocol: 'openai-responses', requiresTransform: true });
  });

  it('selects transform to anthropic messages for openai chat requests when needed', () => {
    const selected = selectTargetProtocolForRequest('openai-chat-completions', ['anthropic-messages']);
    expect(selected).toEqual({ targetProtocol: 'anthropic-messages', requiresTransform: true });
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
  it('returns the original request for same-protocol transforms', () => {
    const request = makeRequest();
    const result = transformRequest(request, { from: 'anthropic-messages', to: 'anthropic-messages' });
    expect(result).not.toBeNull();
    expect(result!.request).toBe(request);
    expect(result!.streamRequested).toBe(true);
    expect(result!.requestedModel).toBe('claude-sonnet');
  });

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

  it('preserves anthropic image blocks when rendering chat completions', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 128,
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'What is in this image?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aW1hZ2U=' } },
          ],
        }],
      })),
    }), { from: 'anthropic-messages', to: 'openai-chat-completions' });
    expect(transformed).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as { messages: Array<{ content: unknown }> };
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'What is in this image?' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,aW1hZ2U=' } },
    ]);
  });

  it('preserves chat image URLs when rendering anthropic messages', () => {
    const transformed = transformRequest(makeRequest({
      path: '/v1/chat/completions',
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4o',
        messages: [{
          role: 'user',
          content: [
            { type: 'text', text: 'Describe this' },
            { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,anBn' } },
          ],
        }],
      })),
    }), { from: 'openai-chat-completions', to: 'anthropic-messages' });
    expect(transformed).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as { messages: Array<{ content: unknown[] }> };
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'anBn' } },
    ]);
  });

  it('preserves responses input images when rendering anthropic messages', () => {
    const transformed = transformRequest(makeRequest({
      path: '/v1/responses',
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4o',
        input: [{
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Describe this' },
            { type: 'input_image', image_url: 'data:image/webp;base64,d2VicA==' },
          ],
        }],
      })),
    }), { from: 'openai-responses', to: 'anthropic-messages' });
    expect(transformed).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as { messages: Array<{ content: unknown[] }> };
    expect(body.messages[0]!.content).toEqual([
      { type: 'text', text: 'Describe this' },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'd2VicA==' } },
    ]);
  });

  it('preserves mixed assistant text and tool calls in one chat message', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 128,
        messages: [{
          role: 'assistant',
          content: [
            { type: 'text', text: 'I will search.' },
            { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'antseed' } },
          ],
        }],
      })),
    }), { from: 'anthropic-messages', to: 'openai-chat-completions' });
    expect(transformed).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.messages).toEqual([{
      role: 'assistant',
      content: 'I will search.',
      tool_calls: [{
        id: 'toolu_1',
        type: 'function',
        function: { name: 'search', arguments: '{"q":"antseed"}' },
      }],
    }]);
  });
});

describe('prompt cache breakpoints', () => {
  const decode = (body: Uint8Array): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
  const long = 'The repository holds the protocol SDK, plugins, a CLI and a desktop app. '.repeat(120);
  const anthropicRequest = (body: Record<string, unknown>): SerializedHttpRequest =>
    makeRequest({ body: new TextEncoder().encode(JSON.stringify(body)) });
  const responsesRequest = (body: Record<string, unknown>): SerializedHttpRequest =>
    makeRequest({ path: '/v1/responses', body: new TextEncoder().encode(JSON.stringify(body)) });

  it('carries an anthropic session identity to a chat-completions cache key', () => {
    const transformed = transformRequest(anthropicRequest({
      model: 'claude-sonnet',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
      metadata: { user_id: 'user_abc_session_f00d' },
    }), { from: 'anthropic-messages', to: 'openai-chat-completions' });

    expect(decode(transformed!.request.body).prompt_cache_key).toBe('user_abc_session_f00d');
  });

  it('omits the chat-completions cache key when the request has no session identity', () => {
    const transformed = transformRequest(anthropicRequest({
      model: 'claude-sonnet',
      max_tokens: 128,
      messages: [{ role: 'user', content: 'hello' }],
    }), { from: 'anthropic-messages', to: 'openai-chat-completions' });

    expect(decode(transformed!.request.body).prompt_cache_key).toBeUndefined();
  });

  it('gives an anthropic seller breakpoints a responses client never declares', () => {
    const transformed = transformRequest(responsesRequest({
      model: 'gpt-5',
      instructions: `You are a coding agent. ${long}`,
      input: [{ role: 'user', content: [{ type: 'input_text', text: long }] }],
    }), { from: 'openai-responses', to: 'anthropic-messages' });

    const body = decode(transformed!.request.body);
    expect(body.system).toEqual([{
      type: 'text',
      text: `You are a coding agent. ${long}`,
      cache_control: { type: 'ephemeral' },
    }]);
    // The last turn closes the prefix, so the next turn reads all of it back.
    const messages = body.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect(messages.at(-1)!.content.at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('marks the tools when an anthropic seller gets no system prompt', () => {
    const transformed = transformRequest(responsesRequest({
      model: 'gpt-5',
      tools: [{ type: 'function', name: 'write', description: long, parameters: { type: 'object' } }],
      input: [{ role: 'user', content: [{ type: 'input_text', text: long }] }],
    }), { from: 'openai-responses', to: 'anthropic-messages' });

    const body = decode(transformed!.request.body);
    expect((body.tools as Array<Record<string, unknown>>).at(-1)!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('leaves a short prompt unmarked — a cache write there costs more than it saves', () => {
    const transformed = transformRequest(responsesRequest({
      model: 'gpt-5',
      instructions: 'You are terse.',
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
    }), { from: 'openai-responses', to: 'anthropic-messages' });

    const body = decode(transformed!.request.body);
    expect(body.system).toBe('You are terse.');
    expect(JSON.stringify(body)).not.toContain('cache_control');
  });

  it('reproduces the breakpoints a client declared rather than synthesizing new ones', () => {
    // Same-protocol requests are passed through untouched, so exercise the
    // round trip directly: a client that declares breakpoints must get back
    // exactly those positions, not the standard pair.
    const canonical = normalizeAnthropicMessagesRequestBody({
      model: 'claude-sonnet',
      max_tokens: 128,
      system: [
        { type: 'text', text: 'You are a coding agent.' },
        { type: 'text', text: long, cache_control: { type: 'ephemeral' } },
      ],
      messages: [
        { role: 'user', content: [{ type: 'text', text: long, cache_control: { type: 'ephemeral' } }] },
        { role: 'assistant', content: [{ type: 'text', text: 'noted' }] },
        { role: 'user', content: [{ type: 'text', text: 'and now?' }] },
      ],
    });
    expect(canonical.cacheBreakpoints).toEqual({ instructions: true, tools: false, inputIndices: [0] });

    const rendered = renderCanonicalRequestToAnthropicMessagesBody(canonical);
    const messages = rendered.messages as Array<{ content: Array<Record<string, unknown>> }>;
    expect((rendered.system as Array<Record<string, unknown>>)[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(messages[0]!.content[0]!.cache_control).toEqual({ type: 'ephemeral' });
    // The client left the final turn unmarked — it stays unmarked.
    expect(messages.at(-1)!.content.at(-1)!.cache_control).toBeUndefined();
  });

  it('records no breakpoints for an anthropic request that declares none', () => {
    const canonical = normalizeAnthropicMessagesRequestBody({
      model: 'claude-sonnet',
      max_tokens: 128,
      system: 'be helpful',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(canonical.cacheBreakpoints).toBeUndefined();
  });
});

describe('transformRequest anthropic to responses', () => {
  it('rewrites anthropic messages to responses input and strips anthropic-only headers', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 256,
        stream: true,
        system: 'be helpful',
        stop_sequences: ['END'],
        metadata: { trace: 'abc' },
        user: 'user-123',
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
    }), { from: 'anthropic-messages', to: 'openai-responses' });
    expect(transformed).not.toBeNull();
    expect(transformed!.request.path).toBe('/v1/responses');
    expect(transformed!.streamRequested).toBe(true);
    expect(transformed!.requestedModel).toBe('claude-sonnet');
    expect(transformed!.request.headers['anthropic-version']).toBeUndefined();

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.model).toBe('claude-sonnet');
    expect(body.instructions).toBe('be helpful');
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(256);
    expect(body.stop).toEqual(['END']);
    expect(body.metadata).toBeUndefined();
    expect(body.user).toBeUndefined();
    expect(body.prompt_cache_key).toBe('user-123');
    expect(body.tool_choice).toEqual({ type: 'function', name: 'write' });
    expect(body.tools).toEqual([{
      type: 'function',
      name: 'write',
      description: 'Write a file',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
    }]);

    const input = body.input as Array<Record<string, unknown>>;
    expect(input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });

  it('maps anthropic metadata.user_id to a responses prompt_cache_key', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 256,
        metadata: { user_id: 'user_abc_session_f00d' },
        messages: [
          { role: 'user', content: 'hello' },
        ],
      })),
    }), { from: 'anthropic-messages', to: 'openai-responses' });

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('user_abc_session_f00d');
    expect(body.metadata).toBeUndefined();
    expect(body.user).toBeUndefined();
  });

  it('omits prompt_cache_key when the anthropic request has no session identity', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'hello' },
        ],
      })),
    }), { from: 'anthropic-messages', to: 'openai-responses' });

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBeUndefined();
  });

  it('forces upstream responses streaming without changing original non-stream preference', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'hello' },
        ],
      })),
    }), { from: 'anthropic-messages', to: 'openai-responses' });

    expect(transformed).not.toBeNull();
    expect(transformed!.streamRequested).toBe(false);
    expect(transformed!.request.headers['x-antseed-client-stream-requested']).toBe('false');

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it('honors an explicit streaming preference when rendering responses requests', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 256,
        messages: [
          { role: 'user', content: 'hello' },
        ],
      })),
    }), { from: 'anthropic-messages', to: 'openai-responses', streamRequested: true });

    expect(transformed).not.toBeNull();
    expect(transformed!.streamRequested).toBe(true);
    expect(transformed!.request.headers['x-antseed-client-stream-requested']).toBe('true');

    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;
    expect(body.stream).toBe(true);
  });

  it('preserves tool calls and tool results through responses input', () => {
    const transformed = transformRequest(makeRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'claude-sonnet',
        max_tokens: 128,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'I will search.' },
              { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'antseed' } },
            ],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' },
            ],
          },
        ],
      })),
    }), { from: 'anthropic-messages', to: 'openai-responses' });
    const body = JSON.parse(new TextDecoder().decode(transformed!.request.body)) as Record<string, unknown>;

    expect(body.input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'I will search.' }] },
      {
        type: 'function_call',
        id: 'fc_toolu_1',
        call_id: 'fc_toolu_1',
        name: 'search',
        arguments: '{"q":"antseed"}',
      },
      {
        type: 'function_call_output',
        call_id: 'fc_toolu_1',
        output: 'found',
      },
    ]);
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

describe('transformResponse', () => {
  it('returns the original response for same-protocol transforms', () => {
    const response = makeOpenAIResponse();
    const transformed = transformResponse(response, {
      from: 'openai-chat-completions',
      to: 'openai-chat-completions',
    });

    expect(transformed).toBe(response);
  });

  it('converts through the canonical response format', () => {
    const transformed = transformResponse(makeOpenAIResponse(), {
      from: 'openai-chat-completions',
      to: 'anthropic-messages',
      streamRequested: false,
      fallbackModel: 'claude-sonnet',
    });

    expect(transformed).not.toBeNull();
    expect(transformed!.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(transformed!.body)) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.stop_reason).toBe('tool_use');
    expect(body.content).toEqual([
      { type: 'text', text: 'Working on it' },
      { type: 'tool_use', id: 'call_123', name: 'write', input: { path: 'hello.txt' } },
    ]);
  });

  it('can render a non-stream upstream response as target SSE', () => {
    const transformed = transformResponse(makeAnthropicResponse(), {
      from: 'anthropic-messages',
      to: 'openai-chat-completions',
      streamRequested: true,
      fallbackModel: 'gpt-4.1',
    });

    expect(transformed).not.toBeNull();
    expect(transformed!.headers['content-type']).toBe('text/event-stream');
    const sseText = new TextDecoder().decode(transformed!.body);
    expect(sseText).toContain('chat.completion.chunk');
    expect(sseText).toContain('"content":"Working on it"');
    expect(sseText).toContain('"finish_reason":"tool_calls"');
    expect(sseText).toContain('data: [DONE]');
  });

  it('normalizes errors to the target response protocol', () => {
    const transformed = transformResponse({
      requestId: 'req-error',
      statusCode: 429,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      })),
    }, {
      from: 'openai-responses',
      to: 'anthropic-messages',
      streamRequested: false,
    });

    expect(transformed).not.toBeNull();
    const body = JSON.parse(new TextDecoder().decode(transformed!.body)) as Record<string, unknown>;
    expect(body).toEqual({
      type: 'error',
      error: { type: 'api_error', message: 'Rate limit exceeded' },
    });
  });

  it('returns null for unsupported response protocols', () => {
    expect(transformResponse(makeOpenAIResponse(), {
      from: 'openai-completions',
      to: 'anthropic-messages',
    })).toBeNull();
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

describe('createStreamingAdapter anthropic to chat', () => {
  it('uses one fallback response id when message_start has not supplied an id yet', () => {
    const dateNow = vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)
      .mockReturnValueOnce(2000)
      .mockReturnValueOnce(3000);

    try {
      const adapter = createStreamAdapterForTest('anthropic-messages', 'openai-chat-completions', '');
      const chunks = adapter.adaptChunk({
        requestId: 'req-anthropic-chat',
        data: new TextEncoder().encode(
          'event: content_block_delta\n'
          + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
          + 'event: content_block_delta\n'
          + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n',
        ),
        done: false,
      });

      const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
      const ids = events
        .filter((event) => event.data !== '[DONE]')
        .map((event) => (JSON.parse(event.data) as Record<string, unknown>).id);

      expect(ids.length).toBeGreaterThanOrEqual(2);
      expect(new Set(ids)).toEqual(new Set(['chatcmpl-1']));
    } finally {
      dateNow.mockRestore();
    }
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

describe('native responses passthrough', () => {
  const decode = (body: Uint8Array): Record<string, unknown> =>
    JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;

  it('preserves the exact request and cache-relevant history fields', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        previous_response_id: 'resp_previous',
        prompt_cache_key: 'conversation-42',
        prompt_cache_retention: '24h',
        include: ['reasoning.encrypted_content'],
        input: [
          { type: 'reasoning', id: 'rs_native', encrypted_content: 'encrypted' },
          {
            type: 'function_call',
            id: 'fc_native',
            call_id: 'tool_native',
            name: 'search',
            arguments: '{}',
          },
          {
            type: 'message',
            id: 'msg_native',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'cached prefix', annotations: [] }],
          },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
        ],
      })),
    });

    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-responses' });

    expect(result).not.toBeNull();
    expect(result!.request).toBe(request);
    expect(result!.request.body).toBe(request.body);
  });

  it('repairs only legacy synthesized IDs while preserving cache fields', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.5',
        previous_response_id: 'resp_previous',
        prompt_cache_key: 'conversation-42',
        prompt_cache_retention: '24h',
        input: [
          {
            type: 'message',
            id: 'chatcmpl-legacy_msg_1',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'legacy prefix', annotations: [] }],
          },
          { type: 'item_reference', id: 'chatcmpl-reference_msg_1' },
          {
            type: 'function_call',
            id: 'tool_legacy',
            call_id: 'tool_legacy',
            name: 'search',
            arguments: '{}',
          },
          { type: 'item_reference', id: 'tool_legacy' },
          { type: 'message', id: 'msg_native', role: 'assistant', content: [] },
        ],
      })),
    });

    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-responses' });
    const body = decode(result!.request.body);
    const input = body.input as Array<Record<string, unknown>>;

    expect(result!.request).not.toBe(request);
    expect(body.previous_response_id).toBe('resp_previous');
    expect(body.prompt_cache_key).toBe('conversation-42');
    expect(body.prompt_cache_retention).toBe('24h');
    expect(input[0].id).toBe('msg_chatcmpl-legacy_1');
    expect(input[1].id).toBe('msg_chatcmpl-reference_1');
    expect(input[2]).toMatchObject({ id: 'fc_tool_legacy', call_id: 'tool_legacy' });
    expect(input[3].id).toBe('fc_tool_legacy');
    expect(input[4].id).toBe('msg_native');
  });

  it('preserves the exact response and does not create a stream adapter', () => {
    const response: SerializedHttpResponse = {
      requestId: 'req-native-response',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        id: 'resp_native',
        output: [{ type: 'message', id: 'msg_native', role: 'assistant', content: [] }],
      })),
    };

    expect(transformResponse(response, { from: 'openai-responses', to: 'openai-responses' })).toBe(response);
    expect(createStreamingAdapter({ from: 'openai-responses', to: 'openai-responses' })).toBeNull();
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

  it('preserves shared request fields when converting responses to chat', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'test',
        stop: ['END'],
        metadata: { trace: 'abc' },
        user: 'user-123',
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;

    expect(body.stop).toEqual(['END']);
    expect(body.metadata).toEqual({ trace: 'abc' });
    expect(body.user).toBe('user-123');
  });

  it('preserves Responses phases and prevents commentary-only completion in chat tool workflows', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-5.6-sol',
        instructions: 'Keep working until the task is complete.',
        input: [
          {
            type: 'message',
            role: 'assistant',
            phase: 'commentary',
            content: [{ type: 'output_text', text: 'I am checking the diff.' }],
          },
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue.' }] },
        ],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      })),
    });

    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toContain('do not end with commentary alone');
    expect(messages[1]).toEqual({
      role: 'assistant',
      name: 'commentary',
      content: 'I am checking the diff.',
    });
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

  it('omits tool_choice when a Codex compaction request has no tools', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [{
          role: 'user',
          content: [{ type: 'input_text', text: 'summarize the conversation' }],
        }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
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

  it('keeps parallel tool calls in one assistant message followed by their results', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'function_call', call_id: 'get_goal:0', name: 'get_goal', arguments: '{}' },
          { type: 'function_call', call_id: 'search:1', name: 'search', arguments: '{"q":"antseed"}' },
          { type: 'function_call_output', call_id: 'get_goal:0', output: 'ship it' },
          { type: 'function_call_output', call_id: 'search:1', output: 'done' },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe('assistant');
    expect((messages[0].tool_calls as Array<Record<string, unknown>>).map((call) => call.id))
      .toEqual(['get_goal:0', 'search:1']);
    expect(messages[1]).toEqual({ role: 'tool', tool_call_id: 'get_goal:0', content: 'ship it' });
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'search:1', content: 'done' });
  });

  it('groups parallel function calls into a single assistant tool_calls message', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: 'run two things' },
          { type: 'function_call', call_id: 'exec_command:0', name: 'exec_command', arguments: '{"cmd":"ls"}' },
          { type: 'function_call', call_id: 'exec_command:1', name: 'exec_command', arguments: '{"cmd":"pwd"}' },
          { type: 'function_call_output', call_id: 'exec_command:0', output: 'a b c' },
          { type: 'function_call_output', call_id: 'exec_command:1', output: '/tmp' },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(4);
    expect(messages[1].role).toBe('assistant');
    expect((messages[1].tool_calls as unknown[]).length).toBe(2);
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'exec_command:0', content: 'a b c' });
    expect(messages[3]).toEqual({ role: 'tool', tool_call_id: 'exec_command:1', content: '/tmp' });
  });

  it('drops reasoning items instead of emitting empty user messages', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: 'hi' },
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'function_call', call_id: 'exec_command:0', name: 'exec_command', arguments: '{}' },
          { type: 'function_call_output', call_id: 'exec_command:0', output: 'ok' },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'user', content: 'hi' });
    expect(messages[1].role).toBe('assistant');
    expect(messages[2].role).toBe('tool');
  });

  it('drops reasoning items so they cannot split a tool call from its result', () => {
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          { type: 'reasoning', id: 'rs_1', summary: [] },
          { type: 'function_call', call_id: 'get_goal:0', name: 'get_goal', arguments: '{}' },
          { type: 'reasoning', id: 'rs_2', summary: [] },
          { type: 'function_call_output', call_id: 'get_goal:0', output: 'ship it' },
        ],
      })),
    });
    const result = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    const messages = body.messages as Array<Record<string, unknown>>;

    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
    expect(messages[2]).toEqual({ role: 'tool', tool_call_id: 'get_goal:0', content: 'ship it' });
  });

  it('returns null for unsupported request protocols', () => {
    const request = makeResponsesRequest();
    expect(transformRequest(request, { from: 'openai-completions', to: 'openai-chat-completions' })).toBeNull();
  });
});

describe('transformRequest responses to anthropic', () => {
  it('omits tool_choice when no tools are available', () => {
    const result = transformRequest(makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: 'summarize the conversation',
        tools: [],
        tool_choice: 'auto',
      })),
    }), { from: 'openai-responses', to: 'anthropic-messages' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('converts responses input, tools, and shared fields to anthropic messages', () => {
    const result = transformRequest(makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [
          { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
          {
            type: 'function_call',
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
        instructions: 'be helpful',
        max_output_tokens: 64,
        stop: ['END'],
        metadata: { trace: 'abc' },
        user: 'user-123',
        tools: [{ type: 'function', name: 'search', parameters: { type: 'object' } }],
        tool_choice: { type: 'function', name: 'search' },
      })),
    }), { from: 'openai-responses', to: 'anthropic-messages' });
    expect(result).not.toBeNull();
    expect(result!.request.path).toBe('/v1/messages');

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.system).toBe('be helpful');
    expect(body.max_tokens).toBe(64);
    expect(body.stop_sequences).toEqual(['END']);
    expect(body.metadata).toEqual({ trace: 'abc', user_id: 'user-123' });
    expect(body.user).toBeUndefined();
    expect(body.tools).toEqual([{ name: 'search', input_schema: { type: 'object' } }]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'search' });
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_search_1', name: 'search', input: { q: 'antseed' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_search_1', content: 'done' }],
      },
    ]);
  });

  it('defaults max_tokens when the responses request omits max_output_tokens', () => {
    const result = transformRequest(makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
      })),
    }), { from: 'openai-responses', to: 'anthropic-messages' });
    expect(result).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
  });

  it('defaults max_tokens when the chat completions request omits max_tokens', () => {
    const result = transformRequest({
      requestId: 'req-chat-no-max',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hello' }],
      })),
    }, { from: 'openai-chat-completions', to: 'anthropic-messages' });
    expect(result).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.max_tokens).toBe(DEFAULT_ANTHROPIC_MAX_TOKENS);
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
    expect(output[0].phase).toBeUndefined();

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

  it('preserves cached input token details in responses usage', () => {
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-cache',
        model: 'gpt-4.1',
        choices: [{
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'cached' },
        }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 8,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      })),
    });

    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.usage).toMatchObject({
      input_tokens: 1000,
      output_tokens: 8,
      total_tokens: 1008,
      input_tokens_details: { cached_tokens: 900 },
    });
  });

  it('maps Anthropic cache reads to Responses cached token details', () => {
    const anthropicResponse = makeAnthropicResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'msg_cache',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet',
        content: [{ type: 'text', text: 'cached' }],
        stop_reason: 'end_turn',
        usage: {
          input_tokens: 3000,
          cache_read_input_tokens: 34_500_000,
          output_tokens: 42,
        },
      })),
    });

    const result = adaptResponseForTest('anthropic-messages', 'openai-responses', anthropicResponse);
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.usage).toMatchObject({
      input_tokens: 34_503_000,
      output_tokens: 42,
      total_tokens: 34_503_042,
      input_tokens_details: { cached_tokens: 34_500_000 },
    });
  });

  it('maps tool calls to function_call items', () => {
    const result = adaptResponseForTest('openai-chat-completions', 'openai-responses', makeOpenAIResponse(), {
      fallbackModel: 'fallback',
    });
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    const output = body.output as Array<Record<string, unknown>>;

    // Should have message item + function_call item
    const functionCall = output.find((item) => item.type === 'function_call');
    const message = output.find((item) => item.type === 'message');
    expect(message?.phase).toBe('commentary');
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

describe('transformRequest chat to responses', () => {
  it('omits tool_choice when no tools are available', () => {
    const request: SerializedHttpRequest = {
      requestId: 'req-chat-to-resp-no-tools',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'summarize the conversation' }],
        tools: [],
        tool_choice: 'auto',
      })),
    };
    const result = transformRequest(request, { from: 'openai-chat-completions', to: 'openai-responses' });
    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;

    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });

  it('preserves shared request fields when converting chat to responses', () => {
    const request: SerializedHttpRequest = {
      requestId: 'req-chat-to-resp',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hello' }],
        max_tokens: 64,
        stop: ['END'],
        metadata: { trace: 'abc' },
        user: 'user-123',
      })),
    };
    const result = transformRequest(request, { from: 'openai-chat-completions', to: 'openai-responses' });
    expect(result).not.toBeNull();

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(result!.streamRequested).toBe(false);
    expect(result!.request.headers['x-antseed-client-stream-requested']).toBe('false');
    expect(body.stream).toBe(true);
    expect(body.max_output_tokens).toBe(64);
    expect(body.stop).toEqual(['END']);
    expect(body.metadata).toEqual({ trace: 'abc' });
    expect(body.user).toBe('user-123');
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ]);
  });

  it('carries an explicit prompt_cache_key through to the responses body', () => {
    const request: SerializedHttpRequest = {
      requestId: 'req-chat-cache-key',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        messages: [{ role: 'user', content: 'hello' }],
        prompt_cache_key: 'conv-42',
      })),
    };
    const result = transformRequest(request, { from: 'openai-chat-completions', to: 'openai-responses' });

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.prompt_cache_key).toBe('conv-42');
  });
});

describe('transformRequest chat to anthropic', () => {
  it('converts chat messages and tool calls to anthropic messages', () => {
    const request: SerializedHttpRequest = {
      requestId: 'req-chat-to-anthropic',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        model: 'gpt-4.1',
        stream: true,
        messages: [
          { role: 'system', content: 'be helpful' },
          { role: 'user', content: 'hello' },
          {
            role: 'assistant',
            content: 'I will search',
            tool_calls: [{
              id: 'call_1',
              type: 'function',
              function: { name: 'search', arguments: '{"q":"antseed"}' },
            }],
          },
          { role: 'tool', tool_call_id: 'call_1', content: 'done' },
        ],
        max_tokens: 64,
      })),
    };

    const result = transformRequest(request, { from: 'openai-chat-completions', to: 'anthropic-messages' });
    expect(result).not.toBeNull();
    expect(result!.request.path).toBe('/v1/messages');
    expect(result!.streamRequested).toBe(true);

    const body = JSON.parse(new TextDecoder().decode(result!.request.body)) as Record<string, unknown>;
    expect(body.system).toBe('be helpful');
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will search' },
          { type: 'tool_use', id: 'call_1', name: 'search', input: { q: 'antseed' } },
        ],
      },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }] },
    ]);
  });
});

describe('transformResponse responses to anthropic', () => {
  it('maps openai responses payloads to anthropic message payloads', () => {
    const responsesResponse = adaptResponseForTest('openai-chat-completions', 'openai-responses', makeOpenAIResponse(), {
      fallbackModel: 'fallback',
    });
    const result = adaptResponseForTest('openai-responses', 'anthropic-messages', responsesResponse, {
      streamRequested: false,
      fallbackModel: 'claude-sonnet',
    });
    expect(result.headers['content-type']).toBe('application/json');

    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.type).toBe('message');
    expect(body.role).toBe('assistant');
    expect(body.model).toBe('gpt-4.1');
    expect(body.stop_reason).toBe('tool_use');

    const content = body.content as Array<Record<string, unknown>>;
    expect(content).toEqual([
      { type: 'text', text: 'Working on it' },
      { type: 'tool_use', id: 'call_123', name: 'write', input: { path: 'hello.txt' } },
    ]);
  });

  it('maps cached Responses usage to Anthropic cache fields', () => {
    const result = adaptResponseForTest('openai-responses', 'anthropic-messages', {
      requestId: 'req-resp-cache',
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        id: 'resp_cache',
        model: 'gpt-5.5',
        status: 'completed',
        output: [{
          type: 'message',
          id: 'msg_1',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'cached' }],
        }],
        usage: {
          input_tokens: 34_503_000,
          input_tokens_details: { cached_tokens: 34_500_000 },
          output_tokens: 42,
        },
      })),
    }, {
      streamRequested: false,
      fallbackModel: 'claude-sonnet',
    });

    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body.usage).toEqual({
      input_tokens: 3000,
      output_tokens: 42,
      cache_read_input_tokens: 34_500_000,
    });
  });

  it('maps incomplete responses stop reasons to anthropic stop reasons', () => {
    const cases: Array<{ reason: string; expectedStopReason: string }> = [
      { reason: 'max_output_tokens', expectedStopReason: 'max_tokens' },
      { reason: 'content_filter', expectedStopReason: 'content_filter' },
    ];

    for (const { reason, expectedStopReason } of cases) {
      const result = adaptResponseForTest('openai-responses', 'anthropic-messages', {
        requestId: `req-incomplete-${reason}`,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          id: `resp_${reason}`,
          model: 'gpt-4.1',
          status: 'incomplete',
          incomplete_details: { reason },
          output: [{
            type: 'message',
            id: 'msg_1',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Partial answer' }],
          }],
          usage: { input_tokens: 8, output_tokens: 4 },
        })),
      }, {
        streamRequested: false,
        fallbackModel: 'claude-sonnet',
      });

      const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
      expect(body.stop_reason).toBe(expectedStopReason);
    }
  });

  it('maps openai responses errors to anthropic errors', () => {
    const result = adaptResponseForTest('openai-responses', 'anthropic-messages', {
      requestId: 'req-error',
      statusCode: 429,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({
        error: { message: 'Rate limit exceeded', type: 'rate_limit_error' },
      })),
    }, {
      streamRequested: false,
      fallbackModel: 'claude-sonnet',
    });

    expect(result.headers['content-type']).toBe('application/json');
    const body = JSON.parse(new TextDecoder().decode(result.body)) as Record<string, unknown>;
    expect(body).toEqual({
      type: 'error',
      error: {
        type: 'api_error',
        message: 'Rate limit exceeded',
      },
    });
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

  it('marks streamed text as commentary when accompanied by tool calls', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'openai-responses', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-commentary-tool',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-tool","model":"gpt-5.6-sol","choices":[{"delta":{"content":"I am checking."},"finish_reason":null}]}\n\n'
        + 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"exec_command","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const messageDone = events.find((event) => {
      if (event.event !== 'response.output_item.done') return false;
      return JSON.parse(event.data).item?.type === 'message';
    });
    const completed = events.find((event) => event.event === 'response.completed');

    expect(JSON.parse(messageDone!.data).item.phase).toBe('commentary');
    expect(JSON.parse(completed!.data).response.output[0].phase).toBe('commentary');
  });

  it('tells Codex to stop when chat-only models use the explicit final-answer tool', () => {
    const finalText = 'The test suite now covers both cases.';
    const request = makeResponsesRequest({
      body: new TextEncoder().encode(JSON.stringify({
        model: 'kimi-k3',
        instructions: 'Continue working with tools until done.',
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add tests.' }] }],
        tools: [{ type: 'function', name: 'exec_command', parameters: { type: 'object' } }],
      })),
    });
    const transformed = transformRequest(request, { from: 'openai-responses', to: 'openai-chat-completions' })!;
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-interim',
        model: 'kimi-k3',
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: finalText, tool_calls: [{ id: 'call_final', type: 'function', function: { name: 'final_answer', arguments: '{}' } }] } }],
        usage: { prompt_tokens: 20, completion_tokens: 7 },
      })),
    });
    const adapted = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse, { fallbackModel: 'kimi-k3' });
    const body = JSON.parse(new TextDecoder().decode(adapted.body)) as Record<string, unknown>;

    expect(JSON.parse(new TextDecoder().decode(transformed.request.body)).messages[0].content)
      .toContain('include the next tool call');
    expect(body.end_turn).toBe(true);
  });

  it('tells Codex to continue after unmarked chat text responses', () => {
    const chatResponse = makeOpenAIResponse({
      body: new TextEncoder().encode(JSON.stringify({
        id: 'chatcmpl-final',
        model: 'kimi-k3',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'The test suite now covers both cases.' } }],
        usage: { prompt_tokens: 20, completion_tokens: 9 },
      })),
    });
    const adapted = adaptResponseForTest('openai-chat-completions', 'openai-responses', chatResponse, { fallbackModel: 'kimi-k3' });
    const body = JSON.parse(new TextDecoder().decode(adapted.body)) as Record<string, unknown>;

    expect(body.end_turn).toBe(false);
  });

  it('converts unmarked chat text streams into explicit tool terminations', () => {
    const adapter = createStreamAdapterForTest('openai-chat-completions', 'openai-responses', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-interim-stream',
      data: new TextEncoder().encode(
        'data: {"id":"chatcmpl-final-stream","model":"kimi-k3","choices":[{"delta":{"content":"The test suite now covers both cases."},"finish_reason":"stop"}]}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });
    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const completed = events.find((event) => event.event === 'response.completed');

    const response = JSON.parse(completed!.data).response;
    expect(response.end_turn).toBe(true);
    expect(response.output[0].type).toBe('message');
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

describe('createStreamingAdapter responses to anthropic', () => {
  it('converts responses SSE frames into anthropic SSE frames incrementally', () => {
    const adapter = createStreamAdapterForTest('openai-responses', 'anthropic-messages', '');
    const start = adapter.adaptStart({
      requestId: 'req-resp-anthropic',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    });
    expect(start.headers['content-type']).toBe('text/event-stream');

    const chunks = adapter.adaptChunk({
      requestId: 'req-resp-anthropic',
      data: new TextEncoder().encode(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_1","object":"response","model":"gpt-4.1","status":"in_progress","output":[],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n'
        + 'event: response.output_item.added\n'
        + 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"","annotations":[]}]}}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"Hello","logprobs":[]}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":" world","logprobs":[]}\n\n'
        + 'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_1","object":"response","model":"gpt-4.1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],"output_text":"Hello world","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: message_start');
    expect(sseText).toContain('event: content_block_start');
    expect(sseText).toContain('"text":"Hello"');
    expect(sseText).toContain('"text":" world"');
    expect(sseText).toContain('event: message_delta');
    expect(sseText).toContain('"stop_reason":"end_turn"');
    expect(sseText).toContain('event: message_stop');
  });

  it('uses contiguous anthropic block indices for mixed text and tool streams', () => {
    const adapter = createStreamAdapterForTest('openai-responses', 'anthropic-messages', '');
    const chunks = adapter.adaptChunk({
      requestId: 'req-resp-anthropic-tool',
      data: new TextEncoder().encode(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_tool","object":"response","model":"gpt-4.1","status":"in_progress","output":[],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n'
        + 'event: response.output_item.added\n'
        + 'data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[{"type":"output_text","text":"","annotations":[]}]}}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"Searching...","logprobs":[]}\n\n'
        + 'event: response.output_item.added\n'
        + 'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"search","arguments":"","status":"in_progress"}}\n\n'
        + 'event: response.function_call_arguments.delta\n'
        + 'data: {"type":"response.function_call_arguments.delta","output_index":1,"item_id":"fc_1","call_id":"fc_1","delta":"{\\"q\\":\\"antseed\\"}"}\n\n'
        + 'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_tool","object":"response","model":"gpt-4.1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Searching...","annotations":[]}]},{"type":"function_call","id":"fc_1","call_id":"fc_1","name":"search","arguments":"{\\"q\\":\\"antseed\\"}","status":"completed"}],"output_text":"Searching...","usage":{"input_tokens":7,"output_tokens":3,"total_tokens":10}}}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const events = parseSseEvents(chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join(''));
    const toolStart = events.find(
      (event) => event.event === 'content_block_start' && event.data.includes('"type":"tool_use"'),
    );
    const toolDelta = events.find(
      (event) => event.event === 'content_block_delta' && event.data.includes('"input_json_delta"'),
    );
    const messageDelta = events.find((event) => event.event === 'message_delta');

    expect(toolStart?.data).toContain('"index":1');
    expect(toolDelta?.data).toContain('"index":1');
    expect(toolDelta?.data).toContain('\\"q\\"');
    expect(messageDelta?.data).toContain('"stop_reason":"tool_use"');
  });
});

describe('createStreamingAdapter responses to chat', () => {
  it('converts responses SSE frames into chat completion chunks incrementally', () => {
    const adapter = createStreamAdapterForTest('openai-responses', 'openai-chat-completions', '');
    const start = adapter.adaptStart({
      requestId: 'req-resp-chat',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    });
    expect(start.headers['content-type']).toBe('text/event-stream');

    const chunks = adapter.adaptChunk({
      requestId: 'req-resp-chat',
      data: new TextEncoder().encode(
        'event: response.created\n'
        + 'data: {"type":"response.created","response":{"id":"resp_chat","object":"response","model":"gpt-4.1","status":"in_progress","output":[],"output_text":"","usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":"Hello","logprobs":[]}\n\n'
        + 'event: response.output_text.delta\n'
        + 'data: {"type":"response.output_text.delta","output_index":0,"item_id":"msg_1","content_index":0,"delta":" world","logprobs":[]}\n\n'
        + 'event: response.completed\n'
        + 'data: {"type":"response.completed","response":{"id":"resp_chat","object":"response","model":"gpt-4.1","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello world","annotations":[]}]}],"output_text":"Hello world","usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}\n\n'
        + 'data: [DONE]\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('"object":"chat.completion.chunk"');
    expect(sseText).toContain('"id":"resp_chat"');
    expect(sseText).toContain('"model":"gpt-4.1"');
    expect(sseText).toContain('"content":"Hello"');
    expect(sseText).toContain('"content":" world"');
    expect(sseText).toContain('"finish_reason":"stop"');
    expect(sseText).toContain('data: [DONE]');
  });
});

describe('createStreamingAdapter anthropic to responses', () => {
  it('composes anthropic SSE frames into responses SSE frames incrementally', () => {
    const adapter = createStreamAdapterForTest('anthropic-messages', 'openai-responses', '');
    const start = adapter.adaptStart({
      requestId: 'req-anthropic-resp',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    });
    expect(start.headers['content-type']).toBe('text/event-stream');

    const chunks = adapter.adaptChunk({
      requestId: 'req-anthropic-resp',
      data: new TextEncoder().encode(
        'event: message_start\n'
        + 'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet","usage":{"input_tokens":5,"output_tokens":0}}}\n\n'
        + 'event: content_block_start\n'
        + 'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n'
        + 'event: content_block_delta\n'
        + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
        + 'event: content_block_delta\n'
        + 'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}\n\n'
        + 'event: message_delta\n'
        + 'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}\n\n'
        + 'event: message_stop\n'
        + 'data: {"type":"message_stop"}\n\n',
      ),
      done: true,
    });

    const sseText = chunks.map((chunk) => new TextDecoder().decode(chunk.data)).join('');
    expect(sseText).toContain('event: response.created');
    expect(sseText).toContain('event: response.output_text.delta');
    expect(sseText).toContain('"delta":"Hello"');
    expect(sseText).toContain('"delta":" world"');
    expect(sseText).toContain('event: response.completed');
    expect(sseText).toContain('"status":"completed"');
    expect(sseText).toContain('data: [DONE]');
  });
});

describe('createStreamingAdapter', () => {
  it('returns null for same-protocol streams', () => {
    expect(createStreamingAdapter({
      from: 'openai-chat-completions',
      to: 'openai-chat-completions',
    })).toBeNull();
  });

  it('builds stream adapters from source normalizer and target renderer', () => {
    const adapter = createStreamingAdapter({
      from: 'openai-chat-completions',
      to: 'anthropic-messages',
      fallbackModel: 'claude-sonnet',
    });
    expect(adapter).not.toBeNull();

    const start = adapter!.adaptStart({
      requestId: 'req-stream-registry',
      statusCode: 200,
      headers: { 'content-type': 'text/event-stream' },
      body: new Uint8Array(0),
    });
    expect(start.headers['content-type']).toBe('text/event-stream');
  });
});

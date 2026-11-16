import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { AntAgentProvider } from './provider.js';
import type { AntAgentDefinition } from './loader.js';

// ─── Helpers ─────────────────────────────────────────────────────

function makeBody(obj: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

function parseBody(body: Uint8Array): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
}

function makeReq(body: Record<string, unknown>, path = '/v1/messages'): SerializedHttpRequest {
  return { requestId: 'req-1', method: 'POST', path, headers: {}, body: makeBody(body) };
}

function makeAnthropicTextResponse(text: string): Uint8Array {
  return makeBody({ content: [{ type: 'text', text }] });
}

function makeOpenAITextResponse(text: string): Uint8Array {
  return makeBody({
    choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  });
}

function makeAnthropicToolUseResponse(toolName: string, toolId: string, input: unknown): Uint8Array {
  return makeBody({
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
  });
}

function makeOpenAIToolCallResponse(toolName: string, toolId: string, args: unknown): Uint8Array {
  return makeBody({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  });
}

function makeResponsesTextResponse(text: string): Uint8Array {
  return makeBody({
    id: 'resp-1',
    object: 'response',
    output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }],
    status: 'completed',
  });
}

function makeResponsesFunctionCallResponse(toolName: string, callId: string, args: unknown): Uint8Array {
  return makeBody({
    id: 'resp-1',
    object: 'response',
    output: [{
      type: 'function_call',
      call_id: callId,
      name: toolName,
      arguments: JSON.stringify(args),
    }],
    status: 'completed',
  });
}

// ─── Mock provider ──────────────────────────────────────────────

interface MockProviderOptions {
  responses: Uint8Array[];
}

function mockProvider(opts: MockProviderOptions): Provider & {
  requestBodies: () => Record<string, unknown>[];
  callCount: () => number;
  allRequests: () => SerializedHttpRequest[];
} {
  const _requestBodies: Record<string, unknown>[] = [];
  const _rawRequests: SerializedHttpRequest[] = [];
  let _callIndex = 0;

  return {
    name: 'mock',
    services: ['claude-sonnet-4-5-20250929'],
    pricing: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    maxConcurrency: 10,
    serviceCategories: undefined,
    serviceApiProtocols: undefined,
    getCapacity: () => ({ current: 0, max: 10 }),

    handleRequest: async (req: SerializedHttpRequest): Promise<SerializedHttpResponse> => {
      _rawRequests.push(req);
      _requestBodies.push(parseBody(req.body));
      const responseBody = opts.responses[_callIndex] ?? makeAnthropicTextResponse('fallback');
      _callIndex++;
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      };
    },

    handleRequestStream: async (
      req: SerializedHttpRequest,
      callbacks: ProviderStreamCallbacks,
    ): Promise<SerializedHttpResponse> => {
      _rawRequests.push(req);
      _requestBodies.push(parseBody(req.body));
      const responseBody = opts.responses[_callIndex] ?? makeAnthropicTextResponse('fallback');
      _callIndex++;
      const response: SerializedHttpResponse = {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      };
      callbacks.onResponseStart(response);
      callbacks.onResponseChunk({ requestId: req.requestId, data: responseBody, done: true });
      return response;
    },

    requestBodies: () => _requestBodies,
    callCount: () => _callIndex,
    allRequests: () => _rawRequests,
  };
}

// ─── Test agents ─────────────────────────────────────────────────

function personaOnlyAgent(): AntAgentDefinition {
  return {
    name: 'test-agent',
    persona: 'You are a helpful social media advisor.',
    guardrails: ['Never write posts without explicit request'],
    knowledge: [],

  };
}

function agentWithKnowledge(): AntAgentDefinition {
  return {
    name: 'social-media-advisor',
    persona: 'You are a social media expert.',
    guardrails: ['Always disclose AI when asked'],
    knowledge: [
      {
        name: 'linkedin-posting',
        description: 'Creating and optimizing LinkedIn posts',
        content: '# LinkedIn Posting\nBest practices for LinkedIn...',
      },
      {
        name: 'x-threads',
        description: 'Writing effective X/Twitter threads',
        content: '# X Threads\nHow to write engaging threads...',
      },
      {
        name: 'content-strategy',
        description: 'Content calendars and strategy frameworks',
        content: '# Content Strategy\nPlanning your content...',
      },
    ],

  };
}

// ─── Tests ──────────────────────────────────────────────────────

describe('AntAgentProvider — provider metadata', () => {
  it('forwards serviceCapabilities from the inner provider', () => {
    const inner = mockProvider({ responses: [] });
    const capabilities = {
      'claude-sonnet-4-5-20250929': { reasoning: true, toolUse: true },
    } as unknown as Provider['serviceCapabilities'];
    inner.serviceCapabilities = capabilities;
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    expect(agent.serviceCapabilities).toBe(capabilities);
  });

  it('forwards every discovery metadata field from the inner provider', () => {
    const inner = mockProvider({ responses: [] });
    inner.serviceCategories = { 'claude-sonnet-4-5-20250929': ['coding'] };
    inner.serviceApiProtocols = { 'claude-sonnet-4-5-20250929': ['anthropic-messages'] };
    inner.serviceCapabilities = {
      'claude-sonnet-4-5-20250929': { contextWindow: 200_000, toolUse: true, inputs: ['text', 'image'] },
    };
    inner.serviceUnitBillingModels = {
      'claude-sonnet-4-5-20250929': {
        'anthropic-messages': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.01 }] },
      },
    };
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    expect(agent.name).toBe('mock');
    expect(agent.services).toBe(inner.services);
    expect(agent.serviceCategories).toBe(inner.serviceCategories);
    expect(agent.serviceApiProtocols).toBe(inner.serviceApiProtocols);
    expect(agent.serviceCapabilities).toBe(inner.serviceCapabilities);
    expect(agent.serviceUnitBillingModels).toBe(inner.serviceUnitBillingModels);
  });
});

describe('AntAgentProvider — persona only (no knowledge)', () => {
  it('injects persona + guardrails into system prompt', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('hello')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    const req = makeReq({ messages: [{ role: 'user', content: 'hi' }] });
    await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a helpful social media advisor.');
    expect(system).toContain('Never write posts without explicit request');
    expect(system).toContain('confidential');
  });

  it('makes only one LLM call (no tools, no loop)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('done')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));
    expect(inner.callCount()).toBe(1);
  });

  it('does not inject tool-set instructions when no knowledge', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).not.toContain('antseed_');
  });

  it('wraps buyer system prompt as client context (Anthropic string)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({
      system: 'Buyer system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a helpful social media advisor.');
    expect(system).toContain('<client-context>\nBuyer system prompt\n</client-context>');
  });

  it('wraps buyer system prompt array as client context preserving cache_control', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    const buyerSystem = [
      { type: 'text', text: 'Cached content', cache_control: { type: 'ephemeral' } },
    ];
    await agent.handleRequest(makeReq({
      system: buyerSystem,
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as { type: string; text: string; cache_control?: unknown }[];
    expect(Array.isArray(system)).toBe(true);
    // Agent's system prompt as first block
    expect(system[0]!.text).toContain('You are a helpful social media advisor.');
    // Buyer's content wrapped as client context in second block
    expect(system[1]!.text).toContain('<client-context>\nCached content\n</client-context>');
    expect(system[1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('no tools are injected into the request', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    expect(body.tools).toBeUndefined();
  });
});

describe('AntAgentProvider — agent loop (Anthropic)', () => {
  it('LLM calls antseed_load_knowledge → executed → re-prompt → text (2 calls)', async () => {
    const inner = mockProvider({
      responses: [
        // First call: LLM decides to load knowledge
        makeAnthropicToolUseResponse('antseed_load_knowledge', 'tool-1', { name: 'linkedin-posting' }),
        // Second call: loop sees text (no more tool calls)
        makeAnthropicTextResponse('Here is how to post on LinkedIn.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq({ messages: [{ role: 'user', content: 'How do I post on LinkedIn?' }] });
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(2);

    // First call should have antseed_load_knowledge tool injected
    const firstBody = inner.requestBodies()[0]!;
    const tools = firstBody.tools as { name: string }[];
    expect(tools.some(t => t.name === 'antseed_load_knowledge')).toBe(true);
    // System prompt should contain persona
    const system = firstBody.system as string;
    expect(system).toContain('You are a social media expert.');
    // System prompt should contain tool-set instructions
    expect(system).toContain('antseed_');

    // Second call should have tool result in messages
    const secondBody = inner.requestBodies()[1]!;
    const messages = secondBody.messages as Record<string, unknown>[];
    // Should contain the tool result with knowledge content
    const toolResultMsg = messages.find(m => {
      if (!Array.isArray(m.content)) return false;
      return (m.content as Record<string, unknown>[]).some(b => b.type === 'tool_result');
    });
    expect(toolResultMsg).toBeDefined();

    // Response content
    const result = parseBody(res.body);
    const content = result.content as { type: string; text: string }[];
    expect(content[0]!.text).toBe('Here is how to post on LinkedIn.');
  });

  it('text only response — single call, no loop', async () => {
    const inner = mockProvider({
      responses: [makeAnthropicTextResponse('Simple answer.')],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'What time is it?' }] }));
    expect(inner.callCount()).toBe(1);
  });

  it('buyer tool call only — returned as-is (no loop)', async () => {
    const buyerToolResponse = makeBody({
      content: [{ type: 'tool_use', id: 'buyer-tool-1', name: 'search_web', input: { q: 'test' } }],
    });
    const inner = mockProvider({ responses: [buyerToolResponse] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq({
      messages: [{ role: 'user', content: 'search for me' }],
      tools: [{ name: 'search_web', description: 'Search', input_schema: { type: 'object' } }],
    });
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const result = parseBody(res.body);
    const content = result.content as { type: string; name: string }[];
    expect(content[0]!.name).toBe('search_web');
  });

  it('mixed antseed + buyer tool calls → treated as done (no re-prompt)', async () => {
    // Response has both an antseed tool call and a buyer tool call.
    // Re-prompting would leave the buyer tool_use without a matching tool_result,
    // which the API would reject. So mixed calls are treated as done.
    const mixedResponse = makeBody({
      content: [
        { type: 'tool_use', id: 'antseed-1', name: 'antseed_load_knowledge', input: { name: 'linkedin-posting' } },
        { type: 'tool_use', id: 'buyer-1', name: 'search_web', input: { q: 'linkedin' } },
      ],
    });
    const inner = mockProvider({
      responses: [mixedResponse],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq({
      messages: [{ role: 'user', content: 'help' }],
      tools: [{ name: 'search_web', description: 'Search', input_schema: { type: 'object' } }],
    });
    const res = await agent.handleRequest(req);

    // Should NOT loop — returned after 1 call
    expect(inner.callCount()).toBe(1);
    // Internal tool calls stripped, only buyer tool call remains
    const body = parseBody(res.body);
    const content = body.content as { type: string; name: string }[];
    expect(content).toHaveLength(1);
    expect(content[0]!.name).toBe('search_web');
  });

  it('multiple modules loaded in sequence', async () => {
    const inner = mockProvider({
      responses: [
        // First: load linkedin
        makeAnthropicToolUseResponse('antseed_load_knowledge', 'tool-1', { name: 'linkedin-posting' }),
        // Second: load content-strategy
        makeAnthropicToolUseResponse('antseed_load_knowledge', 'tool-2', { name: 'content-strategy' }),
        // Third: loop sees text (no more tool calls)
        makeAnthropicTextResponse('Combined answer.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const res = await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'Plan my LinkedIn content' }],
    }));

    expect(inner.callCount()).toBe(3);

    // Verify both tool results are in the message history
    const thirdBody = inner.requestBodies()[2]!;
    const messages = thirdBody.messages as Record<string, unknown>[];
    const toolResults = messages.filter(m => {
      if (!Array.isArray(m.content)) return false;
      return (m.content as Record<string, unknown>[]).some(b => b.type === 'tool_result');
    });
    expect(toolResults.length).toBe(2);
  });

  it('unknown module name → error tool result', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicToolUseResponse('antseed_load_knowledge', 'tool-1', { name: 'nonexistent-module' }),
        makeAnthropicTextResponse('I could not find that module.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'help' }] }));

    expect(inner.callCount()).toBe(2);

    // The tool result should indicate an error
    const secondBody = inner.requestBodies()[1]!;
    const messages = secondBody.messages as Record<string, unknown>[];
    const toolResultMsg = messages.find(m => {
      if (!Array.isArray(m.content)) return false;
      return (m.content as Record<string, unknown>[]).some(b => b.type === 'tool_result');
    });
    const blocks = (toolResultMsg as Record<string, unknown>).content as Record<string, unknown>[];
    const toolResult = blocks.find(b => b.type === 'tool_result')!;
    expect(toolResult.is_error).toBe(true);
    expect(toolResult.content).toContain('not found');
  });

  it('max iterations reached → strips internal tool calls from response', async () => {
    // All responses are tool calls — will hit max iterations
    const inner = mockProvider({
      responses: Array(6).fill(null).map((_, i) =>
        makeAnthropicToolUseResponse('antseed_load_knowledge', `tool-${i}`, { name: 'linkedin-posting' }),
      ),
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge(), { maxIterations: 2 });

    const res = await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'help' }] }));

    // 2 iterations + 1 final request = 3 calls
    expect(inner.callCount()).toBe(3);

    // Response should have internal tool calls stripped
    const result = parseBody(res.body);
    const content = result.content as { type: string; name?: string }[];
    const hasInternalToolUse = content.some(
      b => b.type === 'tool_use' && b.name?.startsWith('antseed_'),
    );
    expect(hasInternalToolUse).toBe(false);
  });

  it('guardrails and confidentiality present in system prompt', async () => {
    const inner = mockProvider({
      responses: [makeAnthropicTextResponse('done')],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('Always disclose AI when asked');
    expect(system).toContain('confidential');
  });
});

describe('AntAgentProvider — agent loop (OpenAI)', () => {
  it('tool call → execute → text response', async () => {
    const inner = mockProvider({
      responses: [
        makeOpenAIToolCallResponse('antseed_load_knowledge', 'call-1', { name: 'linkedin-posting' }),
        makeOpenAITextResponse('LinkedIn tips here.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      { messages: [{ role: 'user', content: 'LinkedIn help' }] },
      '/v1/chat/completions',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(2);

    // First call should have tools injected
    const firstBody = inner.requestBodies()[0]!;
    const tools = firstBody.tools as { type: string; function: { name: string } }[];
    expect(tools.some(t => t.function?.name === 'antseed_load_knowledge')).toBe(true);

    // System message should have persona
    const messages = firstBody.messages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('You are a social media expert.');

    // Second call should include tool result message
    const secondBody = inner.requestBodies()[1]!;
    const secondMessages = secondBody.messages as { role: string; content?: string }[];
    const toolMsg = secondMessages.find(m => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain('LinkedIn Posting');

    // Response content
    const result = parseBody(res.body);
    const choices = result.choices as { message: { content: string } }[];
    expect(choices[0]!.message.content).toBe('LinkedIn tips here.');
  });

  it('buyer tool call → returned as-is', async () => {
    const buyerToolResponse = makeOpenAIToolCallResponse('search_web', 'call-1', { q: 'test' });
    const inner = mockProvider({ responses: [buyerToolResponse] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      {
        messages: [{ role: 'user', content: 'search' }],
        tools: [{ type: 'function', function: { name: 'search_web', description: 'Search', parameters: {} } }],
      },
      '/v1/chat/completions',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const result = parseBody(res.body);
    const choices = result.choices as { message: { tool_calls: { function: { name: string } }[] } }[];
    expect(choices[0]!.message.tool_calls[0]!.function.name).toBe('search_web');
  });
});

describe('AntAgentProvider — agent loop (OpenAI Responses)', () => {
  it('tool call → execute → text response', async () => {
    const inner = mockProvider({
      responses: [
        makeResponsesFunctionCallResponse('antseed_load_knowledge', 'call-1', { name: 'linkedin-posting' }),
        makeResponsesTextResponse('LinkedIn tips here.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      { input: [{ role: 'user', content: 'LinkedIn help' }] },
      '/v1/responses',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(2);

    // First call should have tools injected (flat function format)
    const firstBody = inner.requestBodies()[0]!;
    const tools = firstBody.tools as { type: string; name: string }[];
    expect(tools.some(t => t.name === 'antseed_load_knowledge')).toBe(true);
    expect(tools[0]!.type).toBe('function');
    // Should NOT have nested function property (flat Responses API format)
    expect((tools[0] as Record<string, unknown>).function).toBeUndefined();

    // Instructions should have persona
    const instructions = firstBody.instructions as string;
    expect(instructions).toContain('You are a social media expert.');

    // Second call should have function_call + function_call_output in input
    const secondBody = inner.requestBodies()[1]!;
    const input = secondBody.input as Record<string, unknown>[];
    const funcOutput = input.find(i => i.type === 'function_call_output');
    expect(funcOutput).toBeDefined();
    expect((funcOutput as Record<string, unknown>).output).toContain('LinkedIn Posting');

    // Response content
    const result = parseBody(res.body);
    const output = result.output as { type: string; content?: { type: string; text: string }[] }[];
    expect(output[0]!.content![0]!.text).toBe('LinkedIn tips here.');
  });

  it('text only response — single call, no loop', async () => {
    const inner = mockProvider({
      responses: [makeResponsesTextResponse('Simple answer.')],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq(
      { input: 'What time is it?' },
      '/v1/responses',
    ));
    expect(inner.callCount()).toBe(1);
  });

  it('buyer function call only — returned as-is', async () => {
    const buyerFuncCall = makeBody({
      id: 'resp-1',
      object: 'response',
      output: [{ type: 'function_call', call_id: 'call-1', name: 'search_web', arguments: '{"q":"test"}' }],
      status: 'completed',
    });
    const inner = mockProvider({ responses: [buyerFuncCall] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      {
        input: [{ role: 'user', content: 'search for me' }],
        tools: [{ type: 'function', name: 'search_web', description: 'Search', parameters: { type: 'object' } }],
      },
      '/v1/responses',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const result = parseBody(res.body);
    const output = result.output as { type: string; name: string }[];
    expect(output[0]!.name).toBe('search_web');
  });

  it('mixed antseed + buyer function calls → treated as done', async () => {
    const mixedResponse = makeBody({
      id: 'resp-1',
      object: 'response',
      output: [
        { type: 'function_call', call_id: 'call-1', name: 'antseed_load_knowledge', arguments: '{"name":"linkedin-posting"}' },
        { type: 'function_call', call_id: 'call-2', name: 'search_web', arguments: '{"q":"linkedin"}' },
      ],
    });
    const inner = mockProvider({ responses: [mixedResponse] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const req = makeReq(
      {
        input: [{ role: 'user', content: 'help' }],
        tools: [{ type: 'function', name: 'search_web', description: 'Search', parameters: { type: 'object' } }],
      },
      '/v1/responses',
    );
    const res = await agent.handleRequest(req);

    expect(inner.callCount()).toBe(1);
    const body = parseBody(res.body);
    const output = body.output as { type: string; name: string }[];
    // Internal calls stripped, only buyer call remains
    const functionCalls = output.filter(i => i.type === 'function_call');
    expect(functionCalls).toHaveLength(1);
    expect(functionCalls[0]!.name).toBe('search_web');
  });

  it('wraps buyer instructions as client context', async () => {
    const inner = mockProvider({ responses: [makeResponsesTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq(
      {
        input: 'hi',
        instructions: 'Buyer instructions here',
      },
      '/v1/responses',
    ));

    const body = inner.requestBodies()[0]!;
    const instructions = body.instructions as string;
    expect(instructions).toContain('You are a helpful social media advisor.');
    expect(instructions).toContain('<client-context>\nBuyer instructions here\n</client-context>');
  });

  it('string input is preserved (not wrapped in array)', async () => {
    const inner = mockProvider({ responses: [makeResponsesTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq(
      { input: 'hello there' },
      '/v1/responses',
    ));

    const body = inner.requestBodies()[0]!;
    expect(body.input).toBe('hello there');
  });
});

describe('AntAgentProvider — tool injection', () => {
  it('injects antseed tool alongside buyer tools', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    const buyerTools = [
      { name: 'search_web', description: 'Search', input_schema: { type: 'object' } },
    ];
    await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'hi' }],
      tools: buyerTools,
    }));

    const body = inner.requestBodies()[0]!;
    const tools = body.tools as { name: string }[];
    expect(tools.length).toBe(2); // buyer tool + antseed tool
    expect(tools.some(t => t.name === 'search_web')).toBe(true);
    expect(tools.some(t => t.name === 'antseed_load_knowledge')).toBe(true);
  });

  it('includes knowledge catalog in tool description', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    const tools = body.tools as { name: string; description: string }[];
    const knowledgeTool = tools.find(t => t.name === 'antseed_load_knowledge')!;
    expect(knowledgeTool.description).toContain('linkedin-posting');
    expect(knowledgeTool.description).toContain('x-threads');
    expect(knowledgeTool.description).toContain('content-strategy');
  });

  it('no tools injected when no knowledge modules', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    expect(body.tools).toBeUndefined();
  });

  it('skips tool injection when tool_choice is forced', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    await agent.handleRequest(makeReq({
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'forced_tool', description: 'Forced', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'forced_tool' },
    }));

    const body = inner.requestBodies()[0]!;
    const tools = body.tools as { name: string }[];
    // Only buyer's forced tool, no antseed tool
    expect(tools.length).toBe(1);
    expect(tools[0]!.name).toBe('forced_tool');
  });
});

describe('AntAgentProvider — streaming', () => {
  it('buffered loop + streamed final response', async () => {
    const inner = mockProvider({
      responses: [
        makeAnthropicToolUseResponse('antseed_load_knowledge', 'tool-1', { name: 'linkedin-posting' }),
        makeAnthropicTextResponse('Streamed response.'),
      ],
    });
    const agent = new AntAgentProvider(inner, agentWithKnowledge());

    let streamStarted = false;
    const chunks: Uint8Array[] = [];

    const req = makeReq({ messages: [{ role: 'user', content: 'LinkedIn tips' }] });
    const res = await agent.handleRequestStream!(req, {
      onResponseStart: () => { streamStarted = true; },
      onResponseChunk: (chunk) => { chunks.push(chunk.data); },
    });

    expect(streamStarted).toBe(true);
    expect(res.statusCode).toBe(200);
    expect(inner.callCount()).toBe(2);
  });

  it('direct stream for persona-only (no loop needed)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('direct')] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    let streamStarted = false;
    const req = makeReq({ messages: [{ role: 'user', content: 'hi' }] });
    await agent.handleRequestStream!(req, {
      onResponseStart: () => { streamStarted = true; },
      onResponseChunk: () => {},
    });

    expect(streamStarted).toBe(true);
    expect(inner.callCount()).toBe(1);
  });
});

describe('AntAgentProvider — per-service agents', () => {
  function socialAgent(): AntAgentDefinition {
    return {
      name: 'social-agent',
      persona: 'You are a social media expert.',
      guardrails: [],
      knowledge: [
        { name: 'linkedin', description: 'LinkedIn tips', content: '# LinkedIn\nPost daily.' },
      ],
  
    };
  }

  function codingAgent(): AntAgentDefinition {
    return {
      name: 'coding-agent',
      persona: 'You are a coding expert.',
      guardrails: ['Always explain trade-offs'],
      knowledge: [],
  
    };
  }

  it('uses different agents for different services', async () => {
    const inner = mockProvider({
      responses: [
        // social agent: text response (done in 1 call)
        makeAnthropicTextResponse('Post on LinkedIn daily.'),
        // coding agent: text response (done in 1 call)
        makeAnthropicTextResponse('Use TypeScript.'),
      ],
    });

    const agent = new AntAgentProvider(inner, {
      'social-model': socialAgent(),
      'coding-model': codingAgent(),
    });

    // Request for social-model
    await agent.handleRequest(makeReq({
      service: 'social-model',
      messages: [{ role: 'user', content: 'LinkedIn tips?' }],
    }));

    // Social agent should have tools injected (has knowledge)
    const socialBody = inner.requestBodies()[0]!;
    const socialSystem = socialBody.system as string;
    expect(socialSystem).toContain('You are a social media expert.');
    expect(socialBody.tools).toBeDefined();

    // Request for coding-model
    await agent.handleRequest(makeReq({
      service: 'coding-model',
      messages: [{ role: 'user', content: 'What language?' }],
    }));

    // Coding agent injects its persona, no tools (no knowledge)
    const codingBody = inner.requestBodies()[1]!;
    const codingSystem = codingBody.system as string;
    expect(codingSystem).toContain('You are a coding expert.');
    expect(codingSystem).toContain('Always explain trade-offs');
    expect(codingSystem).not.toContain('social media');
    expect(codingBody.tools).toBeUndefined();
  });

  it('passes through unchanged for unmatched services', async () => {
    const inner = mockProvider({
      responses: [makeAnthropicTextResponse('raw response')],
    });

    const agent = new AntAgentProvider(inner, {
      'social-model': socialAgent(),
    });

    // Request for unknown-model — no agent matches, no default
    await agent.handleRequest(makeReq({
      service: 'unknown-model',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    expect(inner.callCount()).toBe(1);
    // Should pass through without system prompt injection
    const body = inner.requestBodies()[0]!;
    expect(body.system).toBeUndefined();
  });

  it('falls back to wildcard agent for unmatched services', async () => {
    const inner = mockProvider({
      responses: [makeAnthropicTextResponse('fallback response')],
    });

    const agent = new AntAgentProvider(inner, {
      'social-model': socialAgent(),
      '*': codingAgent(),
    });

    // Request for unknown-model — falls back to wildcard
    await agent.handleRequest(makeReq({
      service: 'unknown-model',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a coding expert.');
  });

  it('resolves agent from model field (OpenAI format)', async () => {
    const inner = mockProvider({
      responses: [makeOpenAITextResponse('social response')],
    });

    const agent = new AntAgentProvider(inner, {
      'social-model': socialAgent(),
    });

    const req = makeReq(
      { model: 'social-model', messages: [{ role: 'user', content: 'hi' }] },
      '/v1/chat/completions',
    );
    await agent.handleRequest(req);

    // Should have the social persona in system message
    const body = inner.requestBodies()[0]!;
    const messages = body.messages as { role: string; content: string }[];
    const systemMsg = messages.find(m => m.role === 'system');
    expect(systemMsg!.content).toContain('social media expert');
  });

  it('single AntAgentDefinition still works (backward compat)', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, codingAgent());

    await agent.handleRequest(makeReq({
      service: 'any-service',
      messages: [{ role: 'user', content: 'hi' }],
    }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('You are a coding expert.');
  });
});

describe('AntAgentProvider — error handling', () => {
  it('passes through non-JSON requests unchanged', async () => {
    const inner = mockProvider({ responses: [] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    const req: SerializedHttpRequest = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: new TextEncoder().encode('not json'),
    };

    // The inner provider will be called with the original request
    const originalHandler = inner.handleRequest;
    let receivedReq: SerializedHttpRequest | null = null;
    (inner as { handleRequest: typeof originalHandler }).handleRequest = async (r) => {
      receivedReq = r;
      return { requestId: r.requestId, statusCode: 200, headers: {}, body: makeAnthropicTextResponse('ok') };
    };

    await agent.handleRequest(req);
    expect(receivedReq).toBe(req); // Same reference — passed through unchanged
  });

  it('uses custom confidentiality prompt when provided', async () => {
    const inner = mockProvider({ responses: [makeAnthropicTextResponse('ok')] });
    const agent = new AntAgentProvider(inner, {
      ...personaOnlyAgent(),
      confidentialityPrompt: 'Custom: keep everything secret.',
    });

    await agent.handleRequest(makeReq({ messages: [{ role: 'user', content: 'hi' }] }));

    const body = inner.requestBodies()[0]!;
    const system = body.system as string;
    expect(system).toContain('Custom: keep everything secret.');
    expect(system).not.toContain('private and confidential');
  });
});

describe('AntAgentProvider — Provider interface delegation', () => {
  it('delegates name, services, pricing, maxConcurrency, getCapacity', () => {
    const inner = mockProvider({ responses: [] });
    const agent = new AntAgentProvider(inner, personaOnlyAgent());

    expect(agent.name).toBe('mock');
    expect(agent.services).toEqual(['claude-sonnet-4-5-20250929']);
    expect(agent.pricing).toEqual({ defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } });
    expect(agent.maxConcurrency).toBe(10);
    expect(agent.getCapacity()).toEqual({ current: 0, max: 10 });
  });
});

import { describe, it, expect } from 'vitest';
import type { KnowledgeModule } from './loader.js';
import {
  type AntAgentTool,
  knowledgeTool,
  injectTools,
  inspectResponse,
  executeTools,
  appendToolLoop,
  stripInternalToolCalls,
  TOOL_PREFIX,
} from './tools.js';

const testModules: KnowledgeModule[] = [
  { name: 'pricing', description: 'Pricing info', content: 'Price is $10/mo' },
  { name: 'faq', description: 'Frequently asked questions', content: 'Q: What? A: That.' },
];

const testTools: AntAgentTool[] = [knowledgeTool(testModules)];

describe('knowledgeTool', () => {
  it('creates a tool with load_knowledge name', () => {
    const tool = knowledgeTool(testModules);
    expect(tool.name).toBe('load_knowledge');
  });

  it('embeds catalog in description', () => {
    const tool = knowledgeTool(testModules);
    expect(tool.description).toContain('- pricing: Pricing info');
    expect(tool.description).toContain('- faq: Frequently asked questions');
  });

  it('execute returns module content', () => {
    const tool = knowledgeTool(testModules);
    expect(tool.execute({ name: 'pricing' })).toBe('Price is $10/mo');
  });

  it('execute throws for unknown module', () => {
    const tool = knowledgeTool(testModules);
    expect(() => tool.execute({ name: 'nonexistent' })).toThrow('not found');
  });
});

describe('injectTools', () => {
  it('appends internal tools to existing buyer tools (Anthropic)', () => {
    const body = { tools: [{ name: 'buyer_tool' }], messages: [] };
    const result = injectTools(body, testTools, 'anthropic');
    const tools = result.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ name: 'buyer_tool' });
    expect(tools[1].name).toBe('antseed_load_knowledge');
  });

  it('injects multiple tools', () => {
    const customTool: AntAgentTool = {
      name: 'fetch_price',
      description: 'Fetch price',
      parameters: { type: 'object', properties: {} },
      execute: async () => '$10',
    };
    const body = { messages: [] };
    const result = injectTools(body, [...testTools, customTool], 'anthropic');
    const tools = result.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('antseed_load_knowledge');
    expect(tools[1].name).toBe('antseed_fetch_price');
  });

  it('returns body unchanged when no tools', () => {
    const body = { tools: [{ name: 'buyer_tool' }], messages: [] };
    const result = injectTools(body, [], 'anthropic');
    expect(result).toBe(body);
  });

  it('skips injection when tool_choice forces specific function (Anthropic)', () => {
    const body = {
      tools: [{ name: 'buyer_tool' }],
      tool_choice: { type: 'tool', name: 'buyer_tool' },
      messages: [],
    };
    const result = injectTools(body, testTools, 'anthropic');
    expect(result).toBe(body);
  });

  it('skips injection when tool_choice forces specific function (OpenAI)', () => {
    const body = {
      tools: [{ type: 'function', function: { name: 'buyer_tool' } }],
      tool_choice: { type: 'function', function: { name: 'buyer_tool' } },
      messages: [],
    };
    const result = injectTools(body, testTools, 'openai');
    expect(result).toBe(body);
  });

  it('skips injection when tool_choice is none', () => {
    const body = { tool_choice: 'none', messages: [] };
    const result = injectTools(body, testTools, 'anthropic');
    expect(result).toBe(body);
  });

  it('creates tools array when body has no tools', () => {
    const body = { messages: [] };
    const result = injectTools(body, testTools, 'anthropic');
    const tools = result.tools as Record<string, unknown>[];
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('antseed_load_knowledge');
  });

  it('uses OpenAI format when specified', () => {
    const body = { messages: [] };
    const result = injectTools(body, testTools, 'openai');
    const tools = result.tools as Record<string, unknown>[];
    expect(tools[0].type).toBe('function');
    const fn = tools[0].function as Record<string, unknown>;
    expect(fn.name).toBe('antseed_load_knowledge');
  });

  it('uses OpenAI Responses format (flat function)', () => {
    const body = { input: 'hello' };
    const result = injectTools(body, testTools, 'openai-responses');
    const tools = result.tools as Record<string, unknown>[];
    expect(tools[0].type).toBe('function');
    expect(tools[0].name).toBe('antseed_load_knowledge');
    expect(tools[0].function).toBeUndefined(); // flat, not nested
  });
});

describe('inspectResponse', () => {
  it('returns done for text-only response (Anthropic)', () => {
    const response = { content: [{ type: 'text', text: 'hi' }] };
    expect(inspectResponse(response, 'anthropic').type).toBe('done');
  });

  it('returns done for text-only response (OpenAI)', () => {
    const response = { choices: [{ message: { content: 'hi' } }] };
    expect(inspectResponse(response, 'openai').type).toBe('done');
  });

  it('returns done for buyer-only tool calls (Anthropic)', () => {
    const response = {
      content: [{ type: 'tool_use', id: 'tc1', name: 'buyer_search', input: {} }],
    };
    expect(inspectResponse(response, 'anthropic').type).toBe('done');
  });

  it('returns done for buyer-only tool calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: { tool_calls: [{ id: 'tc1', function: { name: 'buyer_search', arguments: '{}' } }] },
      }],
    };
    expect(inspectResponse(response, 'openai').type).toBe('done');
  });

  it('returns continue for antseed_* calls (Anthropic)', () => {
    const response = {
      content: [{ type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: { name: 'pricing' } }],
    };
    const action = inspectResponse(response, 'anthropic');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
    }
  });

  it('returns continue for antseed_* calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: { tool_calls: [{ id: 'tc1', function: { name: 'antseed_load_knowledge', arguments: '{"name":"pricing"}' } }] },
      }],
    };
    const action = inspectResponse(response, 'openai');
    expect(action.type).toBe('continue');
  });

  it('returns done when mixed — buyer calls prevent re-prompt (Anthropic)', () => {
    const response = {
      content: [
        { type: 'tool_use', id: 'tc1', name: 'buyer_search', input: {} },
        { type: 'tool_use', id: 'tc2', name: 'antseed_load_knowledge', input: { name: 'faq' } },
      ],
    };
    expect(inspectResponse(response, 'anthropic').type).toBe('done');
  });

  it('returns done when mixed — buyer calls prevent re-prompt (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          tool_calls: [
            { id: 'tc1', function: { name: 'buyer_search', arguments: '{}' } },
            { id: 'tc2', function: { name: 'antseed_load_knowledge', arguments: '{"name":"faq"}' } },
          ],
        },
      }],
    };
    expect(inspectResponse(response, 'openai').type).toBe('done');
  });

  it('returns done for text-only response (Responses)', () => {
    const response = {
      output: [{ type: 'message', content: [{ type: 'output_text', text: 'hi' }] }],
    };
    expect(inspectResponse(response, 'openai-responses').type).toBe('done');
  });

  it('returns continue for antseed_* calls (Responses)', () => {
    const response = {
      output: [{
        type: 'function_call',
        call_id: 'call-1',
        name: 'antseed_load_knowledge',
        arguments: '{"name":"pricing"}',
      }],
    };
    const action = inspectResponse(response, 'openai-responses');
    expect(action.type).toBe('continue');
    if (action.type === 'continue') {
      expect(action.internalCalls).toHaveLength(1);
      expect(action.internalCalls[0].id).toBe('call-1');
      expect(action.internalCalls[0].arguments).toEqual({ name: 'pricing' });
    }
  });

  it('returns done for buyer-only function calls (Responses)', () => {
    const response = {
      output: [{ type: 'function_call', call_id: 'call-1', name: 'search_web', arguments: '{}' }],
    };
    expect(inspectResponse(response, 'openai-responses').type).toBe('done');
  });

  it('returns done when mixed — buyer calls prevent re-prompt (Responses)', () => {
    const response = {
      output: [
        { type: 'function_call', call_id: 'call-1', name: 'search_web', arguments: '{}' },
        { type: 'function_call', call_id: 'call-2', name: 'antseed_load_knowledge', arguments: '{"name":"faq"}' },
      ],
    };
    expect(inspectResponse(response, 'openai-responses').type).toBe('done');
  });
});

describe('executeTools', () => {
  it('returns module content for valid knowledge load', async () => {
    const calls = [{ id: 'tc1', name: 'antseed_load_knowledge', arguments: { name: 'pricing' } }];
    const results = await executeTools(calls, testTools);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('Price is $10/mo');
    expect(results[0].isError).toBe(false);
  });

  it('returns error for unknown module', async () => {
    const calls = [{ id: 'tc1', name: 'antseed_load_knowledge', arguments: { name: 'nonexistent' } }];
    const results = await executeTools(calls, testTools);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('not found');
  });

  it('returns error for unknown tool name', async () => {
    const calls = [{ id: 'tc1', name: 'antseed_unknown', arguments: {} }];
    const results = await executeTools(calls, testTools);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('Unknown tool');
  });

  it('executes async custom tools', async () => {
    const customTool: AntAgentTool = {
      name: 'fetch_data',
      description: 'Fetch data',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'fetched result',
    };
    const calls = [{ id: 'tc1', name: 'antseed_fetch_data', arguments: {} }];
    const results = await executeTools(calls, [customTool]);
    expect(results).toHaveLength(1);
    expect(results[0].content).toBe('fetched result');
    expect(results[0].isError).toBe(false);
  });

  it('catches tool execution errors', async () => {
    const failingTool: AntAgentTool = {
      name: 'broken',
      description: 'Broken tool',
      parameters: { type: 'object', properties: {} },
      execute: async () => { throw new Error('connection failed'); },
    };
    const calls = [{ id: 'tc1', name: 'antseed_broken', arguments: {} }];
    const results = await executeTools(calls, [failingTool]);
    expect(results).toHaveLength(1);
    expect(results[0].isError).toBe(true);
    expect(results[0].content).toContain('connection failed');
  });
});

describe('appendToolLoop', () => {
  it('appends correctly in Anthropic format', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const assistantResponse = {
      content: [
        { type: 'text', text: 'Let me check.' },
        { type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: { name: 'pricing' } },
      ],
    };
    const results = [{ id: 'tc1', content: 'Price is $10/mo', isError: false }];
    const updated = appendToolLoop(body, assistantResponse, results, 'anthropic');
    const msgs = updated.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(3);
    expect(msgs[1]).toEqual({ role: 'assistant', content: assistantResponse.content });
    const resultBlocks = (msgs[2] as Record<string, unknown>).content as Record<string, unknown>[];
    expect(resultBlocks[0].type).toBe('tool_result');
  });

  it('drops empty unsigned thinking blocks when replaying the assistant turn', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const toolUse = { type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: {} };
    const signed = { type: 'thinking', thinking: '', signature: 'sig' };
    const withText = { type: 'thinking', thinking: 'hmm' };
    const assistantResponse = {
      content: [{ type: 'thinking', thinking: '' }, signed, withText, { type: 'text', text: 'ok' }, toolUse],
    };
    const results = [{ id: 'tc1', content: 'x', isError: false }];
    const updated = appendToolLoop(body, assistantResponse, results, 'anthropic');
    const msgs = updated.messages as Record<string, unknown>[];
    expect(msgs[1]).toEqual({
      role: 'assistant',
      content: [signed, withText, { type: 'text', text: 'ok' }, toolUse],
    });
  });

  it('appends correctly in OpenAI format', () => {
    const body = { messages: [{ role: 'user', content: 'hello' }] };
    const assistantResponse = {
      choices: [{
        message: {
          role: 'assistant',
          tool_calls: [{ id: 'tc1', function: { name: 'antseed_load_knowledge', arguments: '{}' } }],
        },
      }],
    };
    const results = [{ id: 'tc1', content: 'Price is $10/mo', isError: false }];
    const updated = appendToolLoop(body, assistantResponse, results, 'openai');
    const msgs = updated.messages as Record<string, unknown>[];
    expect(msgs).toHaveLength(3);
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'tc1', content: 'Price is $10/mo' });
  });

  it('appends correctly in Responses format', () => {
    const body = { input: [{ role: 'user', content: 'hello' }] };
    const assistantResponse = {
      output: [
        { type: 'function_call', call_id: 'call-1', name: 'antseed_load_knowledge', arguments: '{"name":"pricing"}' },
      ],
    };
    const results = [{ id: 'call-1', content: 'Price is $10/mo', isError: false }];
    const updated = appendToolLoop(body, assistantResponse, results, 'openai-responses');
    const input = updated.input as Record<string, unknown>[];
    expect(input).toHaveLength(3); // original + function_call + function_call_output
    expect(input[1]).toEqual(assistantResponse.output[0]);
    expect(input[2]).toEqual({ type: 'function_call_output', call_id: 'call-1', output: 'Price is $10/mo' });
  });
});

describe('stripInternalToolCalls', () => {
  it('strips antseed_* calls, keeps buyer calls (Anthropic)', () => {
    const response = {
      content: [
        { type: 'text', text: 'Here you go' },
        { type: 'tool_use', id: 'tc1', name: 'buyer_search', input: {} },
        { type: 'tool_use', id: 'tc2', name: 'antseed_load_knowledge', input: { name: 'faq' } },
      ],
    };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    const content = stripped.content as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect((content[1] as Record<string, unknown>).name).toBe('buyer_search');
  });

  it('strips antseed_* calls, keeps buyer calls (OpenAI)', () => {
    const response = {
      choices: [{
        message: {
          tool_calls: [
            { id: 'tc1', function: { name: 'buyer_search', arguments: '{}' } },
            { id: 'tc2', function: { name: 'antseed_load_knowledge', arguments: '{}' } },
          ],
        },
      }],
    };
    const stripped = stripInternalToolCalls(response, 'openai');
    const choices = stripped.choices as { message: Record<string, unknown> }[];
    const toolCalls = choices[0].message.tool_calls as { function: { name: string } }[];
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].function.name).toBe('buyer_search');
  });

  it('preserves stop_reason when nothing is stripped (Anthropic)', () => {
    const response = {
      content: [{ type: 'text', text: 'truncated' }],
      stop_reason: 'max_tokens',
    };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    expect(stripped.stop_reason).toBe('max_tokens');
  });

  it('no-op for text-only response', () => {
    const response = { content: [{ type: 'text', text: 'hello' }] };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    expect((stripped.content as unknown[]).length).toBe(1);
  });

  it('sets finish_reason to stop when all tool_calls removed (OpenAI)', () => {
    const response = {
      choices: [{
        message: { tool_calls: [{ id: 'tc1', function: { name: 'antseed_load_knowledge', arguments: '{}' } }] },
        finish_reason: 'tool_calls',
      }],
    };
    const stripped = stripInternalToolCalls(response, 'openai');
    const choices = stripped.choices as { message: Record<string, unknown>; finish_reason: string }[];
    expect(choices[0].message.tool_calls).toBeUndefined();
    expect(choices[0].finish_reason).toBe('stop');
  });

  it('sets stop_reason to end_turn when all tool_use removed (Anthropic)', () => {
    const response = {
      content: [{ type: 'tool_use', id: 'tc1', name: 'antseed_load_knowledge', input: {} }],
      stop_reason: 'tool_use',
    };
    const stripped = stripInternalToolCalls(response, 'anthropic');
    expect(stripped.stop_reason).toBe('end_turn');
  });

  it('strips antseed_* calls, keeps buyer calls (Responses)', () => {
    const response = {
      output: [
        { type: 'message', content: [{ type: 'output_text', text: 'Here you go' }] },
        { type: 'function_call', call_id: 'call-1', name: 'search_web', arguments: '{}' },
        { type: 'function_call', call_id: 'call-2', name: 'antseed_load_knowledge', arguments: '{}' },
      ],
    };
    const stripped = stripInternalToolCalls(response, 'openai-responses');
    const output = stripped.output as Record<string, unknown>[];
    expect(output).toHaveLength(2);
    expect((output[1] as Record<string, unknown>).name).toBe('search_web');
  });

  it('sets status to completed when all function_calls removed (Responses)', () => {
    const response = {
      output: [{ type: 'function_call', call_id: 'call-1', name: 'antseed_load_knowledge', arguments: '{}' }],
      status: 'requires_action',
    };
    const stripped = stripInternalToolCalls(response, 'openai-responses');
    const output = stripped.output as unknown[];
    expect(output).toHaveLength(0);
    expect(stripped.status).toBe('completed');
  });
});

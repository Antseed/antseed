import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { runAgentLoopStream, type ResolvedAgent } from './agent-loop.js';
import { knowledgeTool } from './tools.js';
import type { AntAgentDefinition } from './loader.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sseEvent(event: string, data: Record<string, unknown>): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
}

/** Real Anthropic SSE chunks for a response that only calls `toolName`. */
function anthropicToolUseStream(toolName: string, toolId: string, input: unknown): Uint8Array[] {
  return [
    sseEvent('message_start', { message: { id: `msg-${toolId}`, model: 'test-model', content: [] } }),
    sseEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} } }),
    sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }),
    sseEvent('content_block_stop', { index: 0 }),
    sseEvent('message_delta', { delta: { stop_reason: 'tool_use' } }),
    sseEvent('message_stop', {}),
  ];
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Inner provider that streams each round's SSE chunks one at a time. */
function sseProvider(rounds: Uint8Array[][]): Provider & { callCount: () => number } {
  let calls = 0;
  return {
    name: 'mock',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    getCapacity: () => ({ current: 0, max: 1 }),
    handleRequest: async () => { throw new Error('buffered path not expected'); },
    handleRequestStream: async (
      req: SerializedHttpRequest,
      callbacks: ProviderStreamCallbacks,
    ): Promise<SerializedHttpResponse> => {
      const chunks = rounds[calls] ?? [];
      calls++;
      const response: SerializedHttpResponse = {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: concat(chunks),
      };
      callbacks.onResponseStart({ ...response, body: new Uint8Array(0) });
      for (const data of chunks) callbacks.onResponseChunk({ requestId: req.requestId, data, done: false });
      callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
      return response;
    },
    callCount: () => calls,
  };
}

function knowledgeAgent(): ResolvedAgent {
  const definition: AntAgentDefinition = {
    name: 'test-agent',
    persona: 'You are a test agent.',
    guardrails: [],
    knowledge: [{ name: 'topic', description: 'A topic', content: '# Topic' }],
  };
  return { definition, tools: [knowledgeTool(definition.knowledge)] };
}

describe('runAgentLoopStream', () => {
  it('does not forward internal tool calls from the final round after max iterations', async () => {
    const inner = sseProvider([
      anthropicToolUseStream('antseed_load_knowledge', 'tool-1', { name: 'topic' }),
      anthropicToolUseStream('antseed_load_knowledge', 'tool-2', { name: 'topic' }),
    ]);
    const agent = knowledgeAgent();
    const req: SerializedHttpRequest = {
      requestId: 'req-1',
      method: 'POST',
      path: '/v1/messages',
      headers: {},
      body: encoder.encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'hi' }] })),
    };

    const forwarded: string[] = [];
    let doneCount = 0;
    await runAgentLoopStream(inner, req, () => agent, {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => {
        if (chunk.done) doneCount++;
        if (chunk.data.length > 0) forwarded.push(decoder.decode(chunk.data));
      },
    }, { maxIterations: 1 });

    // 1 iteration + 1 final call
    expect(inner.callCount()).toBe(2);
    expect(forwarded.join('')).not.toContain('antseed_');
    // The buyer's stream still ends
    expect(doneCount).toBeGreaterThan(0);
  });
});

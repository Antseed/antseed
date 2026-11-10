import { describe, expect, it } from 'vitest';
import { AntAgentProvider } from '../../ant-agent/src/provider.js';
import { parseResponseUsage } from '../src/utils/response-usage.js';
import { computeCostUsdc } from '../src/payments/pricing.js';
import type { Provider, ProviderStreamCallbacks } from '../src/interfaces/seller-provider.js';
import type { SerializedHttpRequest, SerializedHttpResponse } from '../src/types/http.js';

/**
 * Review probe: what an ant-agent seller bills for a streamed Anthropic
 * request with an internal tool turn, against what the buyer can price from
 * the stream it receives. The seller prices the body its provider returns
 * (seller-request-handler: parseResponseUsage(response.body)); the buyer
 * prices the chunks it was sent (buyer-payment-negotiator.estimateCostFromResponse).
 */

const PRICING = { inputUsdPerMillion: 3, outputUsdPerMillion: 15 };
const encoder = new TextEncoder();

/** One Anthropic SSE event, as one upstream chunk. */
const event = (name: string, data: Record<string, unknown>): Uint8Array =>
  encoder.encode(`event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`);

function anthropicTurn(options: { inputTokens: number; outputTokens: number; toolUse?: { id: string; name: string; input: unknown }; text?: string }): Uint8Array[] {
  const block = options.toolUse
    ? [
      event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: options.toolUse.id, name: options.toolUse.name, input: {} } }),
      event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(options.toolUse.input) } }),
    ]
    : [
      event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
      event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: options.text ?? 'answer' } }),
    ];
  return [
    event('message_start', { message: { id: 'msg', type: 'message', role: 'assistant', model: 'claude', content: [], usage: { input_tokens: options.inputTokens, output_tokens: 1 } } }),
    ...block,
    event('content_block_stop', { index: 0 }),
    event('message_delta', { delta: { stop_reason: options.toolUse ? 'tool_use' : 'end_turn' }, usage: { output_tokens: options.outputTokens } }),
    event('message_stop', {}),
  ];
}

function streamingUpstream(turns: Uint8Array[][]): Provider {
  let call = 0;
  const run = async (request: SerializedHttpRequest, callbacks?: ProviderStreamCallbacks): Promise<SerializedHttpResponse> => {
    const chunks = turns[call] ?? turns[turns.length - 1]!;
    call += 1;
    const start: SerializedHttpResponse = { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'text/event-stream' }, body: new Uint8Array(0) };
    callbacks?.onResponseStart(start);
    for (const data of chunks) callbacks?.onResponseChunk({ requestId: request.requestId, data, done: false });
    callbacks?.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(0), done: true });
    return { ...start, body: Buffer.concat(chunks) };
  };
  return {
    name: 'mock',
    services: ['claude'],
    pricing: { defaults: PRICING },
    maxConcurrency: 4,
    getCapacity: () => ({ current: 0, max: 4 }),
    handleRequest: (request) => run(request),
    handleRequestStream: (request, callbacks) => run(request, callbacks),
  } as Provider;
}

const cost = (body: Uint8Array): bigint => {
  const usage = parseResponseUsage(body);
  return computeCostUsdc(usage.freshInputTokens, usage.outputTokens, PRICING, usage.cachedInputTokens);
};

describe('review probe: ant-agent seller billing against what the buyer can price', () => {
  it('a streamed Anthropic request with an internal tool turn bills every model call, and the buyer prices the same total', async () => {
    // Turn 1: 2,000 input tokens, the model loads a knowledge module. Turn 2: the
    // same prompt plus the 7,000-token module, then a 300-token answer.
    const upstream = streamingUpstream([
      anthropicTurn({ inputTokens: 2_000, outputTokens: 40, toolUse: { id: 'toolu_1', name: 'antseed_load_knowledge', input: { name: 'playbook' } } }),
      anthropicTurn({ inputTokens: 9_000, outputTokens: 300, text: 'Here is the answer.' }),
    ]);
    const agent = new AntAgentProvider(upstream, {
      name: 'advisor',
      persona: 'You are an advisor.',
      guardrails: [],
      knowledge: [{ name: 'playbook', description: 'The playbook', content: 'x'.repeat(28_000) }],
    });

    const received: Uint8Array[] = [];
    const response = await agent.handleRequestStream!({
      requestId: 'req-1', method: 'POST', path: '/v1/messages', headers: {},
      body: encoder.encode(JSON.stringify({ model: 'claude', stream: true, messages: [{ role: 'user', content: 'help' }] })),
    }, {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => { received.push(chunk.data); },
    });

    const sellerUsage = parseResponseUsage(response.body);
    const buyerUsage = parseResponseUsage(Buffer.concat(received));
    const sellerCost = cost(response.body);
    const buyerCost = cost(Buffer.concat(received));
    const verifiable = BigInt(Math.ceil(Number(buyerCost) * 1.4));
    console.log(
      `[probe] ant-agent Anthropic stream: seller bills in=${sellerUsage.inputTokens} out=${sellerUsage.outputTokens} cost=${sellerCost}; ` +
      `buyer prices in=${buyerUsage.inputTokens} out=${buyerUsage.outputTokens} cost=${buyerCost}; ` +
      `verifiable (1.4x)=${verifiable}`,
    );
    // The full tool loop is billed: 2,000 + 9,000 input and 40 + 300 output tokens,
    // so 11,000 * 3 + 340 * 15 = 38,100. The buyer sees the same totals as the seller.
    expect(buyerUsage.inputTokens).toBe(11_000);
    expect(sellerUsage.inputTokens).toBe(11_000);
    expect(buyerCost).toBe(sellerCost);
    expect(sellerCost).toBe(38_100n);
    expect(sellerCost <= verifiable, 'the claim is within what counts as verified').toBe(true);
  });

  it('an OpenAI chat stream with an internal tool turn prices the same on both sides', async () => {
    const data = (chunk: Record<string, unknown>): Uint8Array => encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`);
    const upstream = streamingUpstream([
      [
        data({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'antseed_load_knowledge', arguments: '{"name":"playbook"}' } }] } }] }),
        data({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }),
        data({ id: 'c1', choices: [], usage: { prompt_tokens: 2_000, completion_tokens: 40, total_tokens: 2_040 } }),
        encoder.encode('data: [DONE]\n\n'),
      ],
      [
        data({ id: 'c2', choices: [{ index: 0, delta: { role: 'assistant', content: 'Here is the answer.' } }] }),
        data({ id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        data({ id: 'c2', choices: [], usage: { prompt_tokens: 9_000, completion_tokens: 300, total_tokens: 9_300 } }),
        encoder.encode('data: [DONE]\n\n'),
      ],
    ]);
    const agent = new AntAgentProvider(upstream, {
      name: 'advisor', persona: 'You are an advisor.', guardrails: [],
      knowledge: [{ name: 'playbook', description: 'The playbook', content: 'x'.repeat(28_000) }],
    });
    const received: Uint8Array[] = [];
    const response = await agent.handleRequestStream!({
      requestId: 'req-2', method: 'POST', path: '/v1/chat/completions', headers: {},
      body: encoder.encode(JSON.stringify({ model: 'claude', stream: true, messages: [{ role: 'user', content: 'help' }] })),
    }, {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => { received.push(chunk.data); },
    });
    expect(cost(Buffer.concat(received))).toBe(cost(response.body));
    // The full tool loop is billed: (2,000 + 9,000) * 3 + (40 + 300) * 15 = 38,100.
    expect(cost(response.body)).toBe(38_100n);
  });
});

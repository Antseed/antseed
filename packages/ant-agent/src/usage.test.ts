import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { AntAgentProvider } from './provider.js';
import type { AntAgentDefinition } from './loader.js';

// A request that needs two tool rounds costs three upstream model calls. The seller
// meters from the response the provider returns, and the buyer prices the stream it
// received, so both must carry the usage of all three calls, each counted once.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Usage = Record<string, unknown>;

const agent: AntAgentDefinition = {
  name: 'usage-agent',
  persona: 'You answer from your knowledge modules.',
  guardrails: [],
  knowledge: [{ name: 'facts', description: 'Facts', content: 'The answer is 42.' }],
};

function makeReq(body: Record<string, unknown>, path: string): SerializedHttpRequest {
  return { requestId: 'req-1', method: 'POST', path, headers: {}, body: encoder.encode(JSON.stringify(body)) };
}

function sse(events: [name: string | null, data: unknown][]): string {
  return events.map(([name, data]) => `${name ? `event: ${name}\n` : ''}data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`).join('');
}

/** One upstream call per entry. Streams are cut every `chunkBytes` bytes, like network chunks, or sent per SSE event. */
function scriptedProvider(rounds: string[], chunkBytes?: number): Provider & { calls: () => number } {
  let calls = 0;
  const respond = (req: SerializedHttpRequest, contentType: string): SerializedHttpResponse => {
    const body = rounds[calls] ?? rounds[rounds.length - 1]!;
    calls += 1;
    return { requestId: req.requestId, statusCode: 200, headers: { 'content-type': contentType }, body: encoder.encode(body) };
  };
  return {
    name: 'scripted',
    services: ['test-model'],
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
    maxConcurrency: 1,
    getCapacity: () => ({ current: 0, max: 1 }),
    handleRequest: async (req) => respond(req, 'application/json'),
    handleRequestStream: async (req, callbacks) => {
      const response = respond(req, 'text/event-stream');
      callbacks.onResponseStart({ ...response, body: new Uint8Array(0) });
      const pieces: Uint8Array[] = [];
      if (chunkBytes) {
        for (let at = 0; at < response.body.length; at += chunkBytes) pieces.push(response.body.slice(at, at + chunkBytes));
      } else {
        for (const event of decoder.decode(response.body).split(/(?<=\n\n)/)) pieces.push(encoder.encode(event));
      }
      for (const data of pieces) callbacks.onResponseChunk({ requestId: req.requestId, data, done: false });
      callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
      return response;
    },
    calls: () => calls,
  };
}

async function stream(provider: Provider, req: SerializedHttpRequest, options?: { maxIterations?: number }) {
  const chunks: Uint8Array[] = [];
  const callbacks: ProviderStreamCallbacks = {
    onResponseStart: () => {},
    onResponseChunk: (chunk) => { chunks.push(chunk.data); },
  };
  const returned = await new AntAgentProvider(provider, agent, options).handleRequestStream!(req, callbacks);
  const received = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) { received.set(chunk, at); at += chunk.length; }
  return { returned: returned.body, received };
}

function usageOf(event: Record<string, unknown>): Usage | undefined {
  for (const holder of [event, event.response, event.message]) {
    const usage = (holder as Record<string, unknown> | undefined)?.usage;
    if (usage && typeof usage === 'object') return usage as Usage;
  }
  return undefined;
}

/**
 * What a body is billed for, read the way the seller's meter and the buyer's own
 * estimate read it (`parseResponseUsage` in @antseed/buyer-core): a JSON body's
 * usage, or for a stream the largest value each usage field takes in any event.
 */
function billed(body: Uint8Array, fields: string[]): Record<string, number> {
  const text = decoder.decode(body);
  const events: Record<string, unknown>[] = [];
  try {
    events.push(JSON.parse(text) as Record<string, unknown>);
  } catch {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
      // Like the meter, skip a line that is not JSON: hiding a tool call per network chunk can cut an event (#1499).
      try { events.push(JSON.parse(line.slice(5)) as Record<string, unknown>); } catch { /* skipped */ }
    }
  }
  const read = (usage: Usage, field: string): number => {
    const value = field.split('.').reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], usage);
    return typeof value === 'number' ? value : 0;
  };
  return Object.fromEntries(fields.map((field) => [
    field,
    Math.max(0, ...events.map((event) => { const usage = usageOf(event); return usage ? read(usage, field) : 0; })),
  ]));
}

// ─── Anthropic Messages ──────────────────────────────────────────

const ANTHROPIC_FIELDS = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens'];
const ANTHROPIC_ROUNDS = [
  { input_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0, output_tokens: 30 },
  { input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 40 },
  { input_tokens: 220, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000, output_tokens: 500 },
];
const ANTHROPIC_TOTAL = { input_tokens: 470, cache_creation_input_tokens: 2000, cache_read_input_tokens: 4000, output_tokens: 570 };

function anthropicJson(round: number, last: boolean): string {
  return JSON.stringify({
    id: `msg_${round}`, type: 'message', role: 'assistant', model: 'test-model',
    content: last
      ? [{ type: 'text', text: 'The answer is 42.' }]
      : [{ type: 'tool_use', id: `toolu_${round}`, name: 'antseed_load_knowledge', input: { name: 'facts' } }],
    stop_reason: last ? 'end_turn' : 'tool_use',
    usage: ANTHROPIC_ROUNDS[round],
  });
}

/** An Anthropic stream: input counts arrive in message_start, the output count in message_delta. */
function anthropicSse(round: number, last: boolean): string {
  const { output_tokens, ...input } = ANTHROPIC_ROUNDS[round]!;
  const block = last
    ? [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'The answer is 42. Größe ✓' } }],
    ] as [string, unknown][]
    : [
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${round}`, name: 'antseed_load_knowledge', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"name":"facts"}' } }],
    ] as [string, unknown][];
  return sse([
    ['message_start', { type: 'message_start', message: { id: `msg_${round}`, type: 'message', role: 'assistant', model: 'test-model', content: [], usage: { ...input, output_tokens: 1 } } }],
    ...block,
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: last ? 'end_turn' : 'tool_use' }, usage: { output_tokens } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

const anthropicReq = () => makeReq({ model: 'test-model', messages: [{ role: 'user', content: 'What is the answer?' }] }, '/v1/messages');

describe('agent loop usage — Anthropic Messages', () => {
  it('buffered loop: the returned body carries the usage of every upstream call', async () => {
    const inner = scriptedProvider([anthropicJson(0, false), anthropicJson(1, false), anthropicJson(2, true)]);
    const res = await new AntAgentProvider(inner, agent).handleRequest(anthropicReq());

    expect(inner.calls()).toBe(3);
    expect(billed(res.body, ANTHROPIC_FIELDS)).toEqual(ANTHROPIC_TOTAL);
  });

  it.each([
    ['one SSE event per chunk', undefined],
    ['chunks that cut events and UTF-8 characters apart', 37],
  ])('streaming loop (%s): the seller meters and the buyer receives the usage of every upstream call', async (_name, chunkBytes) => {
    const inner = scriptedProvider([anthropicSse(0, false), anthropicSse(1, false), anthropicSse(2, true)], chunkBytes);
    const { returned, received } = await stream(inner, anthropicReq());

    expect(inner.calls()).toBe(3);
    expect(billed(returned, ANTHROPIC_FIELDS)).toEqual(ANTHROPIC_TOTAL);
    expect(billed(received, ANTHROPIC_FIELDS)).toEqual(ANTHROPIC_TOTAL);
    expect(decoder.decode(received)).toContain('The answer is 42. Größe ✓');
  });

  it('streaming loop: the call after the last allowed tool round is counted too', async () => {
    const inner = scriptedProvider([anthropicSse(0, false), anthropicSse(1, false), anthropicSse(2, true)]);
    const { returned, received } = await stream(inner, anthropicReq(), { maxIterations: 2 });

    expect(inner.calls()).toBe(3);
    expect(billed(returned, ANTHROPIC_FIELDS)).toEqual(ANTHROPIC_TOTAL);
    expect(billed(received, ANTHROPIC_FIELDS)).toEqual(ANTHROPIC_TOTAL);
  });

  it('a request answered in one call is passed through byte for byte', async () => {
    const only = anthropicSse(2, true);
    const { returned, received } = await stream(scriptedProvider([only], 37), anthropicReq());

    expect(decoder.decode(returned)).toBe(only);
    expect(decoder.decode(received)).toBe(only);
  });
});

// ─── OpenAI Chat Completions ─────────────────────────────────────

const OPENAI_FIELDS = ['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details.cached_tokens'];
const OPENAI_ROUNDS = [
  { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130, prompt_tokens_details: { cached_tokens: 0 } },
  { prompt_tokens: 180, completion_tokens: 500, total_tokens: 680, prompt_tokens_details: { cached_tokens: 64 } },
];
const OPENAI_TOTAL = { prompt_tokens: 280, completion_tokens: 530, total_tokens: 810, 'prompt_tokens_details.cached_tokens': 64 };

function openaiSse(round: number, last: boolean): string {
  const chunk = (choices: unknown[], usage: unknown = null) => ({ id: `chatcmpl-${round}`, object: 'chat.completion.chunk', model: 'test-model', choices, usage });
  const delta = last
    ? { content: 'The answer is 42.' }
    : { tool_calls: [{ index: 0, id: `call_${round}`, type: 'function', function: { name: 'antseed_load_knowledge', arguments: '{"name":"facts"}' } }] };
  return sse([
    [null, chunk([{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }])],
    [null, chunk([{ index: 0, delta, finish_reason: null }])],
    [null, chunk([{ index: 0, delta: {}, finish_reason: last ? 'stop' : 'tool_calls' }])],
    [null, chunk([], OPENAI_ROUNDS[round])],
    [null, '[DONE]'],
  ]);
}

describe('agent loop usage — OpenAI Chat Completions', () => {
  it.each([
    ['one SSE event per chunk', undefined],
    ['chunks that cut events apart', 37],
  ])('streaming loop (%s): the final usage chunk carries the usage of every upstream call', async (_name, chunkBytes) => {
    const inner = scriptedProvider([openaiSse(0, false), openaiSse(1, true)], chunkBytes);
    const req = makeReq({ model: 'test-model', stream: true, messages: [{ role: 'user', content: 'What is the answer?' }] }, '/v1/chat/completions');
    const { returned, received } = await stream(inner, req);

    expect(inner.calls()).toBe(2);
    expect(billed(returned, OPENAI_FIELDS)).toEqual(OPENAI_TOTAL);
    expect(billed(received, OPENAI_FIELDS)).toEqual(OPENAI_TOTAL);
  });
});

// ─── OpenAI Responses ────────────────────────────────────────────

const RESPONSES_FIELDS = ['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details.cached_tokens'];
const RESPONSES_ROUNDS = [
  { input_tokens: 100, output_tokens: 30, total_tokens: 130, input_tokens_details: { cached_tokens: 0 } },
  { input_tokens: 180, output_tokens: 500, total_tokens: 680, input_tokens_details: { cached_tokens: 64 } },
];
const RESPONSES_TOTAL = { input_tokens: 280, output_tokens: 530, total_tokens: 810, 'input_tokens_details.cached_tokens': 64 };

function responsesSse(round: number, last: boolean): string {
  const item = last
    ? { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'The answer is 42.' }] }
    : { type: 'function_call', call_id: `call_${round}`, name: 'antseed_load_knowledge', arguments: '{"name":"facts"}' };
  const response = { id: `resp_${round}`, object: 'response', model: 'test-model' };
  return sse([
    ['response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [], usage: null } }],
    ['response.output_item.added', { type: 'response.output_item.added', output_index: 0, item }],
    ['response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }],
    ['response.completed', { type: 'response.completed', response: { ...response, status: 'completed', output: [item], usage: RESPONSES_ROUNDS[round] } }],
  ]);
}

describe('agent loop usage — OpenAI Responses', () => {
  it('streaming loop: response.completed carries the usage of every upstream call', async () => {
    const inner = scriptedProvider([responsesSse(0, false), responsesSse(1, true)]);
    const req = makeReq({ model: 'test-model', stream: true, input: 'What is the answer?' }, '/v1/responses');
    const { returned, received } = await stream(inner, req);

    expect(inner.calls()).toBe(2);
    expect(billed(returned, RESPONSES_FIELDS)).toEqual(RESPONSES_TOTAL);
    expect(billed(received, RESPONSES_FIELDS)).toEqual(RESPONSES_TOTAL);
  });
});

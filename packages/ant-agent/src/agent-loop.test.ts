import { describe, it, expect } from 'vitest';
import type {
  Provider,
  SerializedHttpRequest,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';
import { runAgentLoopStream } from './agent-loop.js';
import { knowledgeTool } from './tools.js';
import type { AntAgentDefinition, KnowledgeModule } from './loader.js';

// ─── Helpers ─────────────────────────────────────────────────────

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sse(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function makeReq(): SerializedHttpRequest {
  return {
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/messages',
    headers: {},
    body: encoder.encode(JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] })),
  };
}

const KNOWLEDGE: KnowledgeModule[] = [
  { name: 'linkedin-posting', description: 'LinkedIn tips', content: '# LinkedIn\nPost daily.' },
];

const AGENT: AntAgentDefinition = {
  name: 'test-agent',
  persona: 'You are a helpful social media advisor.',
  guardrails: [],
  knowledge: KNOWLEDGE,
};

/**
 * Fake inner provider shell. `emit` drives the stream callbacks for one call
 * and returns the response body text.
 */
function fakeStreamProvider(
  name: string,
  emit: (req: SerializedHttpRequest, callbacks: ProviderStreamCallbacks) => string,
): Provider {
  return {
    name,
    services: ['claude-sonnet-4-5-20250929'],
    pricing: { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 } },
    maxConcurrency: 1,
    getCapacity: () => ({ current: 0, max: 1 }),
    handleRequest: async (): Promise<SerializedHttpResponse> => {
      throw new Error('unexpected non-streaming call');
    },
    handleRequestStream: async (
      req: SerializedHttpRequest,
      callbacks: ProviderStreamCallbacks,
    ): Promise<SerializedHttpResponse> => {
      const body = emit(req, callbacks);
      return {
        requestId: req.requestId,
        statusCode: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: encoder.encode(body),
      };
    },
  };
}

/**
 * Fake inner provider that streams each iteration's SSE text as raw network
 * chunks cut at arbitrary byte offsets (chunk boundaries that do not align
 * with SSE event boundaries, like a real upstream).
 */
function streamFake(streams: string[], splits: number[][]): Provider {
  let callIndex = 0;
  return fakeStreamProvider('fake', (req, callbacks) => {
    const text = streams[callIndex] ?? '';
    const offsets = [...(splits[callIndex] ?? []), text.length].sort((a, b) => a - b);
    callIndex++;
    let prev = 0;
    for (const off of offsets) {
      const piece = encoder.encode(text.slice(prev, off));
      if (piece.length > 0) {
        callbacks.onResponseChunk({ requestId: req.requestId, data: piece, done: false });
      }
      prev = off;
    }
    callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
    return text;
  });
}

// Iteration 1: buyer text block, then an internal antseed_* tool call block.
const ITER1_SSE = [
  sse('message_start', { type: 'message_start', message: { id: 'msg_1', model: 'claude' } }),
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello buyer' } }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'antseed_load_knowledge' } }),
  sse('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"name": "linkedin-posting"}' } }),
  sse('content_block_stop', { type: 'content_block_stop', index: 1 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' } }),
  sse('message_stop', { type: 'message_stop' }),
].join('');

// Iteration 2 (final): plain text answer.
const ITER2_SSE = [
  sse('message_start', { type: 'message_start', message: { id: 'msg_2', model: 'claude' } }),
  sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
  sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Final answer' } }),
  sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
  sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  sse('message_stop', { type: 'message_stop' }),
].join('');

function collectBuyerStream() {
  const chunks: Uint8Array[] = [];
  let doneCount = 0;
  return {
    callbacks: {
      onResponseStart: () => {},
      onResponseChunk: (chunk: { data: Uint8Array; done: boolean }) => {
        if (chunk.done) doneCount++;
        chunks.push(chunk.data);
      },
    } as ProviderStreamCallbacks,
    text: () => chunks.map(c => decoder.decode(c)).join(''),
    doneCount: () => doneCount,
  };
}

/** Every non-empty line of a forwarded SSE stream must be a complete SSE line. */
function expectWellFormedSse(text: string): string[] {
  const lines = text.split('\n').filter(l => l.length > 0);
  for (const line of lines) {
    expect(line.startsWith('event: ') || line.startsWith('data: ') || line.startsWith(':'),
      `malformed SSE line: ${JSON.stringify(line)}`).toBe(true);
  }
  const events = text.split('\n\n').filter(e => e.length > 0);
  for (const event of events) {
    const dataLine = event.split('\n').find(l => l.startsWith('data: '));
    if (!dataLine) continue;
    expect(() => JSON.parse(dataLine.slice(6)),
      `unparseable SSE event data: ${JSON.stringify(event)}`).not.toThrow();
  }
  return events;
}

async function runLoop(inner: Provider): Promise<{ text: string; doneCount: number }> {
  const buyer = collectBuyerStream();
  await runAgentLoopStream(
    inner,
    makeReq(),
    () => ({ definition: AGENT, tools: [knowledgeTool(KNOWLEDGE)] }),
    buyer.callbacks,
  );
  return { text: buyer.text(), doneCount: buyer.doneCount() };
}

// ─── Tests ───────────────────────────────────────────────────────

describe('runAgentLoopStream — chunk-boundary handling', () => {
  it('forwards well-formed events when chunks align with events (no splits)', async () => {
    const { text, doneCount } = await runLoop(streamFake([ITER1_SSE, ITER2_SSE], [[], []]));

    const events = expectWellFormedSse(text);
    expect(doneCount).toBe(1);
    expect(events.filter(e => e.includes('event: message_start'))).toHaveLength(1);
    expect(events.filter(e => e.includes('event: message_stop'))).toHaveLength(1);
    expect(text).toContain('Hello buyer');
    expect(text).toContain('Final answer');
    expect(text).not.toContain('antseed');
    expect(text).not.toContain('toolu_1');
  });

  it('does not forward a partial event whose tail reveals the internal tool call', async () => {
    // Cut inside the antseed content_block_start event, before its name completes:
    // the first half contains no detectable marker, the second half does.
    const cut = ITER1_SSE.indexOf('"name":"antseed') + 1;
    expect(cut).toBeGreaterThan(0);

    const { text } = await runLoop(streamFake([ITER1_SSE, ITER2_SSE], [[cut], []]));

    const events = expectWellFormedSse(text);
    expect(events.filter(e => e.includes('event: message_start'))).toHaveLength(1);
    expect(events.filter(e => e.includes('event: message_stop'))).toHaveLength(1);
    expect(text).toContain('Hello buyer');
    expect(text).toContain('Final answer');
    expect(text).not.toContain('antseed');
    expect(text).not.toContain('toolu_1');
  });

  it('does not drop the tail of a buyer event that shares a chunk with the tool call', async () => {
    // Cut inside the buyer's text_delta event: its closing brace lands in the
    // next chunk together with the internal tool call start.
    const cut = ITER1_SSE.indexOf('Hello buyer') + 'Hello buyer'.length;
    expect(cut).toBeGreaterThan(0);

    const { text } = await runLoop(streamFake([ITER1_SSE, ITER2_SSE], [[cut], []]));

    const events = expectWellFormedSse(text);
    expect(events.filter(e => e.includes('event: message_start'))).toHaveLength(1);
    expect(events.filter(e => e.includes('event: message_stop'))).toHaveLength(1);
    expect(text).toContain('Hello buyer');
    expect(text).toContain('Final answer');
    expect(text).not.toContain('antseed');
    expect(text).not.toContain('toolu_1');
  });

  it('keeps a nonempty partial chunk buffered until its event completes', async () => {
    // First chunk ends inside the first event's data line, before the first
    // event delimiter. The prefix alone is not a valid SSE event.
    const cut = ITER1_SSE.indexOf('message_start') + 5;
    expect(cut).toBeGreaterThan(0);

    const { text } = await runLoop(streamFake([ITER1_SSE, ITER2_SSE], [[cut], []]));

    const events = expectWellFormedSse(text);
    expect(events.filter(e => e.includes('event: message_start'))).toHaveLength(1);
    // No truncated prefix from the first chunk leaked through as its own event.
    expect(events.some(e => e.startsWith('event: mess\n'))).toBe(false);
  });

  it('delivers a nonempty terminal chunk exactly once', async () => {
    // Provider error paths can emit a complete event body in a done:true chunk.
    // The framing drains it through the event filter, then forwards an empty
    // terminal marker — the payload must not also be replayed raw.
    const payload = ITER2_SSE;
    const inner = fakeStreamProvider('fake-terminal', (req, callbacks) => {
      callbacks.onResponseChunk({ requestId: req.requestId, data: encoder.encode(payload), done: true });
      return payload;
    });
    const { text, doneCount } = await runLoop(inner);
    expect(doneCount).toBe(1);
    expect(text).toBe(payload);
  });

  it('forwards a buffered unterminated tail on an empty terminal chunk exactly once', async () => {
    // A nonempty chunk ends mid-event (no trailing blank line); the next chunk
    // is the empty done:true marker. The buffered tail must be flushed through
    // the event filter and reach the buyer exactly once before completion.
    const cut = ITER2_SSE.indexOf('message_start') + 5;
    expect(cut).toBeGreaterThan(0);
    const tail = ITER2_SSE.slice(0, cut);
    const inner = fakeStreamProvider('fake-empty-terminal', (req, callbacks) => {
      // Nonempty unterminated tail with done:false, then an empty done:true.
      callbacks.onResponseChunk({ requestId: req.requestId, data: encoder.encode(tail), done: false });
      callbacks.onResponseChunk({ requestId: req.requestId, data: new Uint8Array(0), done: true });
      return tail;
    });
    const { text, doneCount } = await runLoop(inner);
    expect(doneCount).toBe(1);
    // The unterminated prefix was buffered, then flushed as an event on the
    // empty terminal chunk. It reaches the buyer once, not zero times and not
    // replayed raw a second time alongside the empty marker.
    expect(text).toBe(tail);
  });

  it('suppresses a message_start split across chunks on a later iteration', async () => {
    // Cut inside iteration 2's message_start event line.
    const cut = ITER2_SSE.indexOf('message_start') + 5;
    expect(cut).toBeGreaterThan(0);

    const { text } = await runLoop(streamFake([ITER1_SSE, ITER2_SSE], [[], [cut]]));

    const events = expectWellFormedSse(text);
    expect(events.filter(e => e.includes('message_start'))).toHaveLength(1);
    expect(events.filter(e => e.includes('event: message_stop'))).toHaveLength(1);
    expect(text).toContain('Final answer');
  });
});

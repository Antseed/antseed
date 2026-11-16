import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SerializedHttpResponseChunk } from '@antseed/node';
import { BaseProvider } from './base-provider.js';

const MODEL = 'test-model';

function provider(): BaseProvider {
  return new BaseProvider({
    name: 'test',
    services: [MODEL],
    pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
    relay: { baseUrl: 'https://api.example.com', authHeaderName: 'x-api-key', authHeaderValue: 'key', maxConcurrency: 2, allowedServices: [MODEL] },
  });
}

/** An upstream SSE stream that records how many events were read from it. */
function upstream(events: string[]) {
  let pulled = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled === events.length) { controller.close(); return; }
      controller.enqueue(new TextEncoder().encode(events[pulled]));
      pulled += 1;
    },
  }, { highWaterMark: 0 });
  return { response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }), pulled: () => pulled };
}

describe('BaseProvider streaming', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => { fetchMock = vi.fn(); globalThis.fetch = fetchMock; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  const request = () => ({
    requestId: 'req-1',
    method: 'POST',
    path: '/v1/chat/completions',
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ model: MODEL, stream: true })),
  });

  it('stops reading the upstream while a chunk is still being delivered', async () => {
    const source = upstream(['data: one\n\n', 'data: two\n\n', 'data: three\n\n']);
    fetchMock.mockResolvedValueOnce(source.response);
    let deliver!: () => void;
    const delivered = new Promise<void>((resolve) => { deliver = resolve; });
    const chunks: SerializedHttpResponseChunk[] = [];

    const done = provider().handleRequestStream(request(), {
      onResponseStart: () => {},
      onResponseChunk: (chunk) => {
        chunks.push(chunk);
        return chunks.length === 1 ? delivered : undefined;
      },
    });

    await vi.waitFor(() => expect(chunks).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(chunks).toHaveLength(1);
    expect(source.pulled()).toBe(1);

    deliver();
    const response = await done;
    expect(source.pulled()).toBe(3);
    expect(new TextDecoder().decode(response.body)).toBe('data: one\n\ndata: two\n\ndata: three\n\n');
  });

  it('keeps reading when delivering a chunk fails', async () => {
    fetchMock.mockResolvedValueOnce(upstream(['data: one\n\n', 'data: two\n\n']).response);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const response = await provider().handleRequestStream(request(), {
      onResponseStart: () => {},
      onResponseChunk: async () => { throw new Error('Cannot send in state closed'); },
    });

    expect(new TextDecoder().decode(response.body)).toBe('data: one\n\ndata: two\n\n');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
